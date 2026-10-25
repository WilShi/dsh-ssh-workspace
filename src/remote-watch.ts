import type { SshCredentialPayload, SshRuntimeCapabilities, SshWorkspaceProfile } from './types.ts'
import { openRemoteHelperSession, type RemoteHelperSession, type RemoteProcess } from './remote-helper.ts'

export interface RemoteFileWatch {
  close(): void
}

interface WatchOptions {
  readonly onChange: (path?: string) => void
  readonly onCapabilities?: (capabilities: SshRuntimeCapabilities) => void
  readonly onError?: (error: Error) => void
}

class ReconnectingRemoteFileWatch implements RemoteFileWatch {
  private stopped = false
  private session?: RemoteHelperSession
  private process?: RemoteProcess
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private attempt = 0
  private remainder = ''

  constructor(
    private readonly profile: SshWorkspaceProfile,
    private readonly credential: SshCredentialPayload | undefined,
    private readonly options: WatchOptions,
  ) {}

  start(): void {
    void this.connect()
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.process?.close()
    this.process = undefined
    this.session?.dispose()
    this.session = undefined
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const session = await openRemoteHelperSession(this.profile, this.credential)
      if (this.stopped) { session.dispose(); return }
      this.session = session
      this.options.onCapabilities?.(session.capabilities)
      if (session.helper === undefined) {
        session.dispose()
        this.session = undefined
        return
      }
      const excludes = Buffer.from(JSON.stringify(this.profile.excludes), 'utf8').toString('base64url')
      const process = await session.spawn(['watch', this.profile.remotePath, excludes, '1'])
      if (this.stopped) { process.close(); session.dispose(); return }
      this.process = process
      this.attempt = 0
      process.stdout.setEncoding('utf8')
      process.stdout.on('data', (chunk: string | Buffer) => this.consume(String(chunk)))
      process.stderr.on('data', () => { /* Retain public diagnostics at the reconnect boundary only. */ })
      void process.wait().then(
        result => {
          if (!this.stopped && result.exitCode !== 0) this.options.onError?.(new Error('远端文件监听连接已中断'))
          this.reconnect()
        },
        error => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
          this.reconnect()
        },
      )
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      this.reconnect()
    }
  }

  private consume(chunk: string): void {
    this.remainder += chunk
    for (;;) {
      const newline = this.remainder.indexOf('\n')
      if (newline < 0) break
      const line = this.remainder.slice(0, newline).trim()
      this.remainder = this.remainder.slice(newline + 1)
      if (line === '') continue
      try {
        const value = JSON.parse(line) as { type?: unknown; path?: unknown; backend?: unknown }
        if (value.type === 'change') this.options.onChange(typeof value.path === 'string' ? value.path : undefined)
        if (value.type === 'ready') this.attempt = 0
      } catch {
        // Ignore a malformed line and keep the long-lived watch channel alive.
      }
    }
  }

  private reconnect(): void {
    this.process = undefined
    this.session?.dispose()
    this.session = undefined
    if (this.stopped || this.reconnectTimer !== undefined) return
    this.attempt = Math.min(this.attempt + 1, 8)
    const delay = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(this.attempt - 1, 6)))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }
}

export function startRemoteFileWatch(
  profile: SshWorkspaceProfile,
  credential: SshCredentialPayload | undefined,
  options: WatchOptions,
): RemoteFileWatch | undefined {
  if (profile.helperMode === 'disabled') return undefined
  const watcher = new ReconnectingRemoteFileWatch(profile, credential, options)
  watcher.start()
  return watcher
}

