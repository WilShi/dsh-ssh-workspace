import { StringDecoder } from 'node:string_decoder'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { openRemoteHelperSession, type RemoteHelperSession, type RemoteProcess } from './remote-helper.ts'
import { shellQuote, spawnSystemSsh } from './system-ssh.ts'
import type { SshCredentialPayload, SshWorkspaceProfile } from './types.ts'

const TRANSCRIPT_LIMIT = 1024 * 1024
const INPUT_LIMIT = 1024 * 1024

export interface TerminalSubscription { dispose(): void }

export interface ProductRemoteTerminal {
  readonly key: string
  readonly title: string
  readonly sessionId: string
  readonly tabId: string
  readonly cwd: string
  readonly transcript: string
  readonly exited: boolean
  readonly exitCode?: number | null
  readonly persistent: boolean
  onData(listener: (data: string) => void): TerminalSubscription
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): TerminalSubscription
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  detach(): void
}

function boundedTranscript(current: string, next: string): string {
  const combined = current + next
  return combined.length <= TRANSCRIPT_LIMIT ? combined : combined.slice(combined.length - TRANSCRIPT_LIMIT)
}

export class PersistentRemoteTerminal implements ProductRemoteTerminal {
  transcript = ''
  exited = false
  exitCode: number | null | undefined
  readonly persistent = true
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
  private helper?: RemoteHelperSession
  private follower?: RemoteProcess
  private offset = 0
  private closed = false
  private detached = false
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private inputTail: Promise<void> = Promise.resolve()
  private pendingInputBytes = 0
  private inputSequence = Date.now() * 1_000
  private readonly decoder = new StringDecoder('utf8')

  private constructor(
    readonly key: string,
    readonly title: string,
    readonly sessionId: string,
    readonly tabId: string,
    readonly cwd: string,
    private readonly profile: SshWorkspaceProfile,
    private readonly credential: SshCredentialPayload | undefined,
    private readonly remoteCwd: string,
    private cols: number,
    private rows: number,
  ) {}

  static async open(options: {
    readonly key: string
    readonly title: string
    readonly sessionId: string
    readonly tabId: string
    readonly cwd: string
    readonly profile: SshWorkspaceProfile
    readonly credential?: SshCredentialPayload
    readonly remoteCwd: string
    readonly cols: number
    readonly rows: number
  }): Promise<PersistentRemoteTerminal | undefined> {
    if (options.profile.helperMode === 'disabled') return undefined
    const terminal = new PersistentRemoteTerminal(
      options.key,
      options.title,
      options.sessionId,
      options.tabId,
      options.cwd,
      options.profile,
      options.credential,
      options.remoteCwd,
      options.cols,
      options.rows,
    )
    const opened = await terminal.connect(true)
    if (!opened) {
      terminal.helper?.dispose()
      return undefined
    }
    return terminal
  }

  onData(listener: (data: string) => void): TerminalSubscription {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): TerminalSubscription {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(data: string): void {
    if (this.closed || this.detached || this.exited || data === '') return
    const bytes = Buffer.byteLength(data)
    if (this.pendingInputBytes + bytes > INPUT_LIMIT) {
      this.emit('\r\n[远程终端输入队列已满，请等待连接恢复]\r\n')
      return
    }
    const sequence = ++this.inputSequence
    this.pendingInputBytes += bytes
    this.inputTail = this.inputTail.then(async () => {
      for (;;) {
        if (this.closed || this.detached || this.exited) return
        const helper = this.helper
        if (helper === undefined) {
          await new Promise<void>(resolve => setTimeout(resolve, 100))
          continue
        }
        try {
          const result = await helper.exec(['terminal-input', this.key, String(sequence)], { input: data })
          if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8').trim() || '远程终端输入失败')
          return
        } catch {
          await new Promise<void>(resolve => setTimeout(resolve, 250))
        }
      }
    }).finally(() => { this.pendingInputBytes = Math.max(0, this.pendingInputBytes - bytes) })
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(2, Math.floor(cols))
    this.rows = Math.max(2, Math.floor(rows))
    const helper = this.helper
    if (helper === undefined || this.closed || this.detached || this.exited) return
    void helper.exec(['terminal-resize', this.key, String(this.cols), String(this.rows)]).catch(() => {})
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.cancelReconnect()
    const helper = this.helper
    this.follower?.close()
    this.follower = undefined
    if (helper !== undefined) {
      void helper.exec(['terminal-close', this.key]).catch(() => {}).finally(() => helper.dispose())
    }
    this.helper = undefined
  }

  detach(): void {
    if (this.closed || this.detached) return
    this.detached = true
    this.cancelReconnect()
    const helper = this.helper
    this.follower?.close()
    this.follower = undefined
    if (helper !== undefined) {
      void helper.exec(['terminal-detach', this.key, String(this.profile.terminalGraceSeconds)])
        .catch(() => {})
        .finally(() => helper.dispose())
    }
    this.helper = undefined
  }

  private async connect(initial: boolean): Promise<boolean> {
    if (this.closed || this.detached || this.exited) return false
    let helper: RemoteHelperSession
    try {
      helper = await openRemoteHelperSession(this.profile, this.credential)
    } catch (error) {
      if (initial) return false
      this.scheduleReconnect(error)
      return false
    }
    if (helper.helper?.tmux !== true) {
      helper.dispose()
      return false
    }
    try {
      const started = await helper.exec([
        'terminal-start', this.key, this.remoteCwd, String(this.cols), String(this.rows),
      ])
      if (started.exitCode !== 0) throw new Error(started.stderr.toString('utf8').trim() || '远程持久终端启动失败')
      const body = JSON.parse(started.stdout.toString('utf8').trim()) as { offset?: unknown }
      if (initial && typeof body.offset === 'number') this.offset = Math.max(0, body.offset - TRANSCRIPT_LIMIT)
      this.helper?.dispose()
      this.helper = helper
      this.reconnectAttempt = 0
      await this.follow()
      return true
    } catch (error) {
      helper.dispose()
      if (initial) return false
      this.scheduleReconnect(error)
      return false
    }
  }

  private async follow(): Promise<void> {
    const helper = this.helper
    if (helper === undefined) return
    const follower = await helper.spawn(['terminal-follow', this.key, String(this.offset)])
    this.follower = follower
    let diagnostic = ''
    follower.stdout.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.offset += value.length
      this.emit(this.decoder.write(value))
    })
    follower.stderr.setEncoding('utf8')
    follower.stderr.on('data', (chunk: string | Buffer) => { diagnostic += String(chunk) })
    void follower.wait().then(
      result => {
        if (this.follower === follower) this.follower = undefined
        if (this.closed || this.detached) return
        const exit = /__DSH_TERMINAL_EXIT__=(\d+)/u.exec(diagnostic)
        if (exit?.[1] !== undefined) {
          this.finish(Number(exit[1]))
          return
        }
        this.scheduleReconnect(new Error(`远程终端连接中断（${String(result.exitCode)}）`))
      },
      error => this.scheduleReconnect(error instanceof Error ? error : new Error(String(error))),
    )
  }

  private scheduleReconnect(error: unknown): void {
    if (this.closed || this.detached || this.exited || this.reconnectTimer !== undefined) return
    this.helper?.dispose()
    this.helper = undefined
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 8)
    const delay = Math.min(30_000, 500 * (2 ** Math.min(this.reconnectAttempt - 1, 6)))
    if (this.reconnectAttempt === 1) this.emit('\r\n[远程连接暂时中断，正在恢复终端…]\r\n')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect(false)
    }, delay)
    this.reconnectTimer.unref?.()
    void error
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private finish(code: number): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    const final = this.decoder.end()
    if (final !== '') this.emit(final)
    for (const listener of this.exitListeners) listener({ exitCode: code })
    this.helper?.dispose()
    this.helper = undefined
  }

  private emit(data: string): void {
    if (data === '') return
    this.transcript = boundedTranscript(this.transcript, data)
    for (const listener of this.dataListeners) listener(data)
  }
}

export class SystemSshRemoteTerminal implements ProductRemoteTerminal {
  transcript = ''
  exited = false
  exitCode: number | null | undefined
  readonly persistent = false
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  private constructor(
    readonly key: string,
    readonly title: string,
    readonly sessionId: string,
    readonly tabId: string,
    readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    const receive = (chunk: Buffer | string): void => this.emit(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    child.once('close', code => {
      this.exited = true
      this.exitCode = code
      for (const listener of this.exitListeners) listener({ exitCode: code ?? 0 })
    })
    child.once('error', error => this.emit(`\r\n[远程终端错误：${error.message}]\r\n`))
  }

  static async open(options: {
    readonly key: string
    readonly title: string
    readonly sessionId: string
    readonly tabId: string
    readonly cwd: string
    readonly profile: SshWorkspaceProfile
    readonly remoteCwd: string
  }): Promise<SystemSshRemoteTerminal> {
    const command = `cd -- ${shellQuote(options.remoteCwd)} && exec "\${SHELL:-/bin/sh}" -l`
    const child = await spawnSystemSsh(options.profile, command, { allocateTty: true })
    return new SystemSshRemoteTerminal(
      options.key, options.title, options.sessionId, options.tabId, options.cwd, child,
    )
  }

  onData(listener: (data: string) => void): TerminalSubscription { this.dataListeners.add(listener); return { dispose: () => this.dataListeners.delete(listener) } }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): TerminalSubscription { this.exitListeners.add(listener); return { dispose: () => this.exitListeners.delete(listener) } }
  write(data: string): void { if (!this.exited) this.child.stdin.write(data) }
  resize(_cols: number, _rows: number): void { /* System OpenSSH owns the remote PTY dimensions. */ }
  close(): void { if (!this.exited) this.child.kill() }
  detach(): void { this.close() }

  private emit(data: string): void {
    this.transcript = boundedTranscript(this.transcript, data)
    for (const listener of this.dataListeners) listener(data)
  }
}

