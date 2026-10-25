import { StringDecoder } from 'node:string_decoder'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import { DSH_SSH_HELPER_SOURCE, DSH_SSH_HELPER_VERSION } from './remote-helper-source.ts'
import {
  closeSftp,
  openSftp,
  openSshConnection,
  type SshConnection,
  SshConnectionError,
} from './ssh-client.ts'
import { execSystemSshCommand, shellQuote, spawnSystemSsh } from './system-ssh.ts'
import type {
  SshCredentialPayload,
  SshHelperMode,
  SshProfileInput,
  SshRuntimeCapabilities,
  SshTransportMode,
  SshWorkspaceProfile,
} from './types.ts'

const HELPER_REMOTE_PATH = '$HOME/.dsh/ssh-helper/dsh-ssh-helper'
const HELPER_INSTALL_COMMAND = [
  'set -eu',
  'umask 077',
  'mkdir -p -- "$HOME/.dsh/ssh-helper"',
  'tmp="$HOME/.dsh/ssh-helper/.install-$$"',
  'trap \'rm -f -- "$tmp"\' EXIT HUP INT TERM',
  'cat > "$tmp"',
  'chmod 700 "$tmp"',
  '"$tmp" probe >/dev/null',
  `mv -f -- "$tmp" "${HELPER_REMOTE_PATH}"`,
  `chmod 700 "${HELPER_REMOTE_PATH}"`,
  'trap - EXIT HUP INT TERM',
].join('; ')
const HELPER_RUNTIME_COMMAND = 'if command -v python3 >/dev/null 2>&1; then printf "python3\\n"; else uname -s 2>/dev/null; uname -m 2>/dev/null; fi'

export interface RemoteProcess {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly stdin: Writable
  close(): void
  wait(): Promise<{ readonly exitCode: number | null; readonly signal?: string }>
}

interface ProfileConnectionInput {
  readonly id?: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly authMode: SshWorkspaceProfile['authMode']
  readonly hostFingerprint?: string
  readonly transportMode: SshTransportMode
  readonly openSshHost?: string
  readonly helperMode: SshHelperMode
}

function transportKind(profile: Pick<ProfileConnectionInput, 'transportMode' | 'authMode' | 'openSshHost'>): 'builtin' | 'system' {
  if (profile.transportMode === 'system' || profile.authMode === 'openssh-config' || profile.openSshHost !== undefined) return 'system'
  return 'builtin'
}

function helperCommand(args: readonly string[]): string {
  return `"${HELPER_REMOTE_PATH}" ${args.map(shellQuote).join(' ')}`
}

function boundedError(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+/gu, ' ').trim().slice(0, 1_000)
}

function parseHelperProbe(value: Buffer | string): RemoteHelperProbe | undefined {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8').trim() : value.trim()) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const probe = parsed as Partial<RemoteHelperProbe>
    if (!Number.isInteger(probe.version) || typeof probe.platform !== 'string'
      || typeof probe.hostname !== 'string' || typeof probe.python !== 'string'
      || typeof probe.tmux !== 'boolean' || typeof probe.inotifywait !== 'boolean'
      || typeof probe.ss !== 'boolean') return undefined
    return probe as RemoteHelperProbe
  } catch {
    return undefined
  }
}

function helperAssetName(runtimeOutput: Buffer | string): string | undefined {
  const lines = (Buffer.isBuffer(runtimeOutput) ? runtimeOutput.toString('utf8') : runtimeOutput)
    .trim().split(/\r?\n/u).map(line => line.trim().toLowerCase()).filter(Boolean)
  if (lines[0] === 'python3') return undefined
  if (lines[0] !== 'linux') throw new Error(`远端没有 Python 3，且平台 ${lines[0] ?? 'unknown'} 暂无原生助手`)
  if (lines[1] === 'x86_64' || lines[1] === 'amd64') return 'dsh-ssh-helper-linux-amd64'
  if (lines[1] === 'aarch64' || lines[1] === 'arm64') return 'dsh-ssh-helper-linux-arm64'
  throw new Error(`远端没有 Python 3，且架构 ${lines[1] ?? 'unknown'} 暂无原生助手`)
}

async function helperInstallPayload(runtimeOutput: Buffer | string): Promise<Buffer | string> {
  const name = helperAssetName(runtimeOutput)
  if (name === undefined) return DSH_SSH_HELPER_SOURCE
  const override = process.env.DSH_SSH_HELPER_ASSET_DIR
  return await readFile(override === undefined || override === ''
    ? new URL(`./helpers/${name}`, import.meta.url)
    : join(override, name))
}

async function execBuiltinRaw(
  connection: SshConnection,
  command: string,
  input?: Buffer | string,
  signal?: AbortSignal,
  outputLimit = 8 * 1024 * 1024,
): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer; readonly exitCode: number | null }> {
  signal?.throwIfAborted()
  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    connection.client.exec(command, (error, stream) => error === undefined ? resolve(stream) : reject(error))
  })
  return await new Promise((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let total = 0
    let settled = false
    const abort = (): void => {
      try { channel.close() } catch { /* already closed */ }
      if (!settled) reject(signal?.reason instanceof Error ? signal.reason : new Error('远程操作已取消'))
      settled = true
    }
    signal?.addEventListener('abort', abort, { once: true })
    const append = (target: Buffer[], chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += value.length
      if (total > outputLimit) {
        settled = true
        try { channel.close() } catch { /* already closed */ }
        reject(new SshConnectionError('REMOTE_OUTPUT_LIMIT', '远程助手输出超过限制'))
        return
      }
      target.push(value)
    }
    channel.on('data', (chunk: Buffer | string) => append(stdout, chunk))
    channel.stderr.on('data', (chunk: Buffer | string) => append(stderr, chunk))
    channel.once('error', (error: Error) => {
      if (!settled) reject(error)
      settled = true
    })
    channel.once('close', (code: number | null) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code })
    })
    if (input === undefined) channel.end()
    else channel.end(input)
  })
}

function builtinProcess(channel: ClientChannel): RemoteProcess {
  let waitPromise: Promise<{ exitCode: number | null; signal?: string }> | undefined
  return {
    stdout: channel,
    stderr: channel.stderr,
    stdin: channel,
    close: () => { try { channel.close() } catch { /* already closed */ } },
    wait: () => {
      waitPromise ??= new Promise((resolve, reject) => {
        channel.once('error', reject)
        channel.once('close', (exitCode: number | null, signal?: string) => resolve({
          exitCode,
          ...(signal === undefined ? {} : { signal }),
        }))
      })
      return waitPromise
    },
  }
}

function systemProcess(child: Awaited<ReturnType<typeof spawnSystemSsh>>): RemoteProcess {
  let waitPromise: Promise<{ exitCode: number | null; signal?: string }> | undefined
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    close: () => { child.kill() },
    wait: () => {
      waitPromise ??= new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => resolve({
          exitCode,
          ...(signal === null ? {} : { signal }),
        }))
      })
      return waitPromise
    },
  }
}

export interface RemoteHelperProbe {
  readonly version: number
  readonly platform: string
  readonly hostname: string
  readonly python: string
  readonly tmux: boolean
  readonly inotifywait: boolean
  readonly ss: boolean
}

export class RemoteHelperSession {
  readonly kind: 'builtin' | 'system'
  readonly connection?: SshConnection
  readonly sftp?: SFTPWrapper
  readonly helper?: RemoteHelperProbe
  readonly capabilities: SshRuntimeCapabilities
  private disposed = false
  private readonly systemProfile?: ProfileConnectionInput

  private constructor(options: {
    readonly kind: 'builtin' | 'system'
    readonly connection?: SshConnection
    readonly sftp?: SFTPWrapper
    readonly helper?: RemoteHelperProbe
    readonly capabilities: SshRuntimeCapabilities
    readonly systemProfile?: ProfileConnectionInput
  }) {
    this.kind = options.kind
    this.connection = options.connection
    this.sftp = options.sftp
    this.helper = options.helper
    this.capabilities = options.capabilities
    this.systemProfile = options.systemProfile
  }

  static async open(
    profile: ProfileConnectionInput,
    credential?: SshCredentialPayload,
  ): Promise<RemoteHelperSession> {
    const kind = transportKind(profile)
    let connection: SshConnection | undefined
    let sftp: SFTPWrapper | undefined
    if (kind === 'builtin') {
      connection = await openSshConnection({
        id: profile.id ?? 'ssh-runtime',
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authMode: profile.authMode,
        ...(profile.hostFingerprint === undefined ? {} : { hostFingerprint: profile.hostFingerprint }),
        ...(credential === undefined ? {} : { credential }),
      })
      try { sftp = await openSftp(connection.client) } catch { /* Helper/terminal-only hosts may not expose SFTP. */ }
    }

    let helper: RemoteHelperProbe | undefined
    let degradedReason: string | undefined
    if (profile.helperMode !== 'disabled') {
      try {
        if (kind === 'builtin') {
          let result = await execBuiltinRaw(connection as SshConnection, helperCommand(['probe']))
          let current = result.exitCode === 0 ? parseHelperProbe(result.stdout) : undefined
          if (current?.version !== DSH_SSH_HELPER_VERSION) {
            const runtime = await execBuiltinRaw(connection as SshConnection, HELPER_RUNTIME_COMMAND)
            if (runtime.exitCode !== 0) throw new Error(boundedError([runtime.stderr]) || '无法识别远端助手运行环境')
            const installed = await execBuiltinRaw(connection as SshConnection, HELPER_INSTALL_COMMAND, await helperInstallPayload(runtime.stdout))
            if (installed.exitCode !== 0) throw new Error(boundedError([installed.stderr]) || `远端助手安装失败（退出码 ${String(installed.exitCode)}）`)
            result = await execBuiltinRaw(connection as SshConnection, helperCommand(['probe']))
            if (result.exitCode !== 0) throw new Error(boundedError([result.stderr]) || '远端助手探测失败')
            current = parseHelperProbe(result.stdout)
            if (current === undefined) throw new Error('远端助手返回了无效的探测结果')
          }
          helper = current
        } else {
          let result = await execSystemSshCommand(profile, '/', helperCommand(['probe']))
          let current = result.exitCode === 0 ? parseHelperProbe(result.stdout) : undefined
          if (current?.version !== DSH_SSH_HELPER_VERSION) {
            const runtime = await execSystemSshCommand(profile, '/', HELPER_RUNTIME_COMMAND)
            if (runtime.exitCode !== 0) throw new Error(runtime.stderr.trim() || '无法识别远端助手运行环境')
            const installed = await execSystemSshCommand(profile, '/', HELPER_INSTALL_COMMAND, undefined, await helperInstallPayload(runtime.stdout))
            if (installed.exitCode !== 0) throw new Error(installed.stderr.trim() || `远端助手安装失败（退出码 ${String(installed.exitCode)}）`)
            result = await execSystemSshCommand(profile, '/', helperCommand(['probe']))
            if (result.exitCode !== 0) throw new Error(result.stderr.trim() || '远端助手探测失败')
            current = parseHelperProbe(result.stdout)
            if (current === undefined) throw new Error('远端助手返回了无效的探测结果')
          }
          helper = current
        }
        if (helper === undefined) throw new Error('远端助手不可用')
        if (helper.version !== DSH_SSH_HELPER_VERSION) throw new Error(`远端助手版本不兼容：${String(helper.version)}`)
      } catch (error) {
        degradedReason = error instanceof Error ? error.message : String(error)
      }
    }

    if (kind === 'system' && helper === undefined) {
      throw new SshConnectionError(
        'REMOTE_HELPER_REQUIRED',
        `系统 OpenSSH 模式需要远端 Python 3 助手：${degradedReason ?? '远端助手不可用'}`,
      )
    }
    const capabilities: SshRuntimeCapabilities = {
      transport: kind,
      sftp: sftp !== undefined,
      helper: helper !== undefined,
      ...(helper === undefined ? {} : { helperVersion: helper.version, remotePlatform: helper.platform }),
      realtimeFileEvents: helper?.inotifywait === true,
      persistentTerminals: helper?.tmux === true,
      portDiscovery: helper !== undefined,
      portForwarding: true,
      proxyJump: kind === 'system' && profile.openSshHost !== undefined,
      keyboardInteractive: false,
      ...(degradedReason === undefined ? {} : { degradedReason }),
    }
    return new RemoteHelperSession({
      kind,
      connection,
      sftp,
      helper,
      capabilities,
      ...(kind === 'system' ? { systemProfile: profile } : {}),
    })
  }

  async exec(
    args: readonly string[],
    options: { readonly input?: Buffer | string; readonly signal?: AbortSignal; readonly outputLimit?: number } = {},
  ): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer; readonly exitCode: number | null }> {
    if (this.disposed) throw new Error('远端助手会话已关闭')
    if (this.helper === undefined) throw new SshConnectionError('REMOTE_HELPER_UNAVAILABLE', '远端助手不可用')
    if (this.kind === 'builtin') {
      return await execBuiltinRaw(
        this.connection as SshConnection,
        helperCommand(args),
        options.input,
        options.signal,
        options.outputLimit,
      )
    }
    const profile = this.systemProfile
    if (profile === undefined) throw new Error('系统 SSH 会话缺少配置')
    const result = await execSystemSshCommand(
      profile,
      '/',
      helperCommand(args),
      options.signal,
      options.input,
      options.outputLimit,
    )
    return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), exitCode: result.exitCode }
  }

  async spawn(args: readonly string[]): Promise<RemoteProcess> {
    if (this.disposed) throw new Error('远端助手会话已关闭')
    if (this.helper === undefined) throw new SshConnectionError('REMOTE_HELPER_UNAVAILABLE', '远端助手不可用')
    if (this.kind === 'builtin') {
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        ;(this.connection as SshConnection).client.exec(helperCommand(args), (error, stream) => {
          if (error === undefined) resolve(stream)
          else reject(error)
        })
      })
      return builtinProcess(channel)
    }
    if (this.systemProfile === undefined) throw new Error('系统 SSH 会话缺少配置')
    return systemProcess(await spawnSystemSsh(this.systemProfile, helperCommand(args)))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.sftp !== undefined) closeSftp(this.sftp)
    this.connection?.dispose()
  }
}

export async function openRemoteHelperSession(
  profile: SshWorkspaceProfile,
  credential?: SshCredentialPayload,
): Promise<RemoteHelperSession> {
  const session = await RemoteHelperSession.open(profile, credential)
  return session
}

export function parseJsonLines<T>(value: Buffer): T[] {
  const decoder = new StringDecoder('utf8')
  const text = decoder.write(value) + decoder.end()
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as T)
}

export function profileConnectionInput(
  input: SshProfileInput & { readonly port?: number },
): ProfileConnectionInput {
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    authMode: input.authMode,
    ...(input.hostFingerprint === undefined ? {} : { hostFingerprint: input.hostFingerprint }),
    transportMode: input.transportMode ?? 'auto',
    ...(input.openSshHost === undefined ? {} : { openSshHost: input.openSshHost }),
    helperMode: input.helperMode ?? 'auto',
  }
}
