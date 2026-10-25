import { isAbsolute as isLocalAbsolute, normalize as normalizeLocalPath } from 'node:path'
import { posix } from 'node:path'
import {
  DEFAULT_EXCLUDES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TERMINAL_GRACE_SECONDS,
  MAX_TERMINAL_GRACE_SECONDS,
  MAX_POLL_INTERVAL_MS,
  MIN_TERMINAL_GRACE_SECONDS,
  MIN_POLL_INTERVAL_MS,
  type SshAuthMode,
  type SshHelperMode,
  type SshProfileInput,
  type SshTransportMode,
  type SshWorkspaceMode,
} from './types.ts'

export class SshWorkspaceValidationError extends Error {
  readonly code = 'INVALID_INPUT'
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new SshWorkspaceValidationError(`${field} 必须是字符串`)
  const text = value.trim()
  if (text.length === 0 || text.length > maximum) {
    throw new SshWorkspaceValidationError(`${field} 长度必须在 1 到 ${maximum} 个字符之间`)
  }
  if (text.includes('\0')) throw new SshWorkspaceValidationError(`${field} 包含无效字符`)
  return text
}

export function normalizeRemotePath(value: unknown): string {
  const input = boundedText(value, '远程目录', 2_048).replaceAll('\\', '/')
  if (!posix.isAbsolute(input)) throw new SshWorkspaceValidationError('远程目录必须是绝对路径')
  const normalized = posix.normalize(input)
  if (!normalized.startsWith('/')) throw new SshWorkspaceValidationError('远程目录必须是绝对路径')
  return normalized
}

export function normalizeHost(value: unknown): string {
  const host = boundedText(value, '服务器地址', 253)
  if (/\s/u.test(host) || host.includes('/') || host.includes('://')) {
    throw new SshWorkspaceValidationError('服务器地址只能填写主机名或 IP，不要包含协议和路径')
  }
  return host
}

export function normalizePort(value: unknown): number {
  const port = value === undefined ? 22 : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SshWorkspaceValidationError('SSH 端口必须是 1 到 65535 之间的整数')
  }
  return port
}

export function normalizeAuthMode(value: unknown): SshAuthMode {
  if (value !== 'password' && value !== 'private-key' && value !== 'agent' && value !== 'openssh-config') {
    throw new SshWorkspaceValidationError('认证方式无效')
  }
  return value
}

export function normalizeTransportMode(value: unknown): SshTransportMode {
  if (value === undefined) return 'auto'
  if (value !== 'auto' && value !== 'builtin' && value !== 'system') {
    throw new SshWorkspaceValidationError('SSH 连接引擎无效')
  }
  return value
}

export function normalizeHelperMode(value: unknown): SshHelperMode {
  if (value === undefined) return 'auto'
  if (value !== 'auto' && value !== 'disabled') throw new SshWorkspaceValidationError('远端助手模式无效')
  return value
}

export function normalizeWorkspaceMode(value: unknown, fallback: SshWorkspaceMode = 'direct'): SshWorkspaceMode {
  if (value === undefined) return fallback
  if (value !== 'direct' && value !== 'mirror') throw new SshWorkspaceValidationError('远程工作区模式无效')
  return value
}

export function normalizeOpenSshHost(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  const alias = boundedText(value, 'OpenSSH 主机', 253)
  if (/\s/u.test(alias) || alias.startsWith('-')) throw new SshWorkspaceValidationError('OpenSSH 主机别名无效')
  return alias
}

export function normalizeFingerprint(value: unknown, required = false): string | undefined {
  if ((value === undefined || value === '') && !required) return undefined
  const fingerprint = boundedText(value, '主机指纹', 128)
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/u.test(fingerprint)) {
    throw new SshWorkspaceValidationError('主机指纹格式无效，应为 SHA256:...')
  }
  return fingerprint.replace(/=$/u, '')
}

export function normalizeExcludes(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_EXCLUDES]
  if (!Array.isArray(value) || value.length > 64) throw new SshWorkspaceValidationError('排除目录格式无效')
  const result = new Set<string>()
  for (const item of value) {
    const name = boundedText(item, '排除目录', 128)
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new SshWorkspaceValidationError(`排除目录只能是单个名称：${name}`)
    }
    result.add(name)
  }
  result.add('.dsh-conflicts')
  return [...result]
}

export interface NormalizedSshProfileInput {
  readonly id?: string
  readonly name: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly remotePath: string
  readonly workspaceMode: SshWorkspaceMode
  readonly hostFingerprint?: string
  readonly authMode: SshAuthMode
  readonly transportMode: SshTransportMode
  readonly openSshHost?: string
  readonly helperMode: SshHelperMode
  readonly terminalGraceSeconds: number
  readonly password?: string
  readonly privateKey?: string
  readonly passphrase?: string
  readonly pollIntervalMs: number
  readonly excludes: readonly string[]
}

export function normalizeProfileInput(input: SshProfileInput, requireFingerprint = false): NormalizedSshProfileInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new SshWorkspaceValidationError('连接配置格式无效')
  }
  const authMode = normalizeAuthMode(input.authMode)
  const transportMode = normalizeTransportMode(input.transportMode)
  const openSshHost = normalizeOpenSshHost(input.openSshHost)
  const helperMode = normalizeHelperMode(input.helperMode)
  const workspaceMode = normalizeWorkspaceMode(input.workspaceMode)
  const password = typeof input.password === 'string' && input.password.length > 0 ? input.password : undefined
  const privateKey = typeof input.privateKey === 'string' && input.privateKey.length > 0 ? input.privateKey : undefined
  const passphrase = typeof input.passphrase === 'string' && input.passphrase.length > 0 ? input.passphrase : undefined
  if (password !== undefined && password.length > 16_384) throw new SshWorkspaceValidationError('密码过长')
  if (privateKey !== undefined && privateKey.length > 1024 * 1024) throw new SshWorkspaceValidationError('私钥内容过大')
  if (passphrase !== undefined && passphrase.length > 16_384) throw new SshWorkspaceValidationError('私钥口令过长')
  if (authMode === 'password' && input.id === undefined && password === undefined) {
    throw new SshWorkspaceValidationError('请填写 SSH 密码')
  }
  if (authMode === 'private-key' && input.id === undefined && privateKey === undefined) {
    throw new SshWorkspaceValidationError('请填写 SSH 私钥')
  }
  if (authMode === 'openssh-config' && openSshHost === undefined) {
    throw new SshWorkspaceValidationError('请选择或填写 OpenSSH 主机别名')
  }
  if (authMode === 'openssh-config' && transportMode === 'builtin') {
    throw new SshWorkspaceValidationError('OpenSSH 配置认证不能使用内置 SSH 引擎')
  }
  if (openSshHost !== undefined && authMode !== 'openssh-config') {
    throw new SshWorkspaceValidationError('OpenSSH 主机别名只能与 OpenSSH 配置认证一起使用')
  }
  if (transportMode === 'system' && authMode !== 'agent' && authMode !== 'openssh-config') {
    throw new SshWorkspaceValidationError('系统 OpenSSH 引擎请使用 OpenSSH 配置或 SSH Agent 认证')
  }
  if ((transportMode === 'system' || authMode === 'openssh-config') && helperMode === 'disabled') {
    throw new SshWorkspaceValidationError('系统 OpenSSH 引擎需要远端助手；请选择自动安装并降级兼容')
  }
  const pollIntervalMs = input.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(input.pollIntervalMs)
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS || pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw new SshWorkspaceValidationError(`同步间隔必须在 ${MIN_POLL_INTERVAL_MS / 1000} 到 ${MAX_POLL_INTERVAL_MS / 1000} 秒之间`)
  }
  const id = input.id === undefined ? undefined : boundedText(input.id, '连接 ID', 96)
  if (id !== undefined && !/^ssh-[a-f0-9-]{36}$/u.test(id)) throw new SshWorkspaceValidationError('连接 ID 无效')
  const terminalGraceSeconds = input.terminalGraceSeconds === undefined
    ? DEFAULT_TERMINAL_GRACE_SECONDS
    : Number(input.terminalGraceSeconds)
  if (!Number.isInteger(terminalGraceSeconds)
    || terminalGraceSeconds < MIN_TERMINAL_GRACE_SECONDS
    || terminalGraceSeconds > MAX_TERMINAL_GRACE_SECONDS) {
    throw new SshWorkspaceValidationError(
      `远程终端保留时间必须在 ${MIN_TERMINAL_GRACE_SECONDS} 到 ${MAX_TERMINAL_GRACE_SECONDS} 秒之间`,
    )
  }
  return {
    ...(id === undefined ? {} : { id }),
    name: boundedText(input.name, '名称', 80),
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    username: boundedText(input.username, '用户名', 128),
    remotePath: normalizeRemotePath(input.remotePath),
    workspaceMode,
    ...(normalizeFingerprint(input.hostFingerprint, requireFingerprint) === undefined
      ? {}
      : { hostFingerprint: normalizeFingerprint(input.hostFingerprint, requireFingerprint) }),
    authMode,
    transportMode,
    ...(openSshHost === undefined ? {} : { openSshHost }),
    helperMode,
    terminalGraceSeconds,
    ...(password === undefined ? {} : { password }),
    ...(privateKey === undefined ? {} : { privateKey }),
    ...(passphrase === undefined ? {} : { passphrase }),
    pollIntervalMs,
    excludes: normalizeExcludes(input.excludes),
  }
}

export function assertCachePath(value: string): string {
  if (!isLocalAbsolute(value)) throw new SshWorkspaceValidationError('缓存目录必须是本地绝对路径')
  return normalizeLocalPath(value)
}

/** Prevent remote path traversal when mapping SFTP entries into the local cache. */
export function safeRelativePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//u, '')
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    throw new SshWorkspaceValidationError(`远程条目路径越界：${value}`)
  }
  return normalized
}
