import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SshPortForwardSpec, SshWorkspaceProfile } from './types.ts'
import {
  DEFAULT_TERMINAL_GRACE_SECONDS,
  MAX_TERMINAL_GRACE_SECONDS,
  MIN_TERMINAL_GRACE_SECONDS,
} from './types.ts'
import {
  assertCachePath,
  normalizeAuthMode,
  normalizeExcludes,
  normalizeFingerprint,
  normalizeHelperMode,
  normalizeHost,
  normalizeOpenSshHost,
  normalizePort,
  normalizeRemotePath,
  normalizeTransportMode,
  normalizeWorkspaceMode,
  SshWorkspaceValidationError,
} from './validation.ts'

interface ProfileDocument {
  readonly version: 1
  readonly profiles: readonly SshWorkspaceProfile[]
}

function text(value: unknown, field: string, maximum = 2_048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new SshWorkspaceValidationError(`保存的 ${field} 无效`)
  }
  return value
}

function isoTime(value: unknown, field: string): string {
  const candidate = text(value, field, 64)
  if (!Number.isFinite(Date.parse(candidate))) throw new SshWorkspaceValidationError(`保存的 ${field} 无效`)
  return candidate
}

function parsePortForwards(value: unknown): readonly SshPortForwardSpec[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new SshWorkspaceValidationError('保存的端口转发配置无效')
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new SshWorkspaceValidationError('保存的端口转发配置无效')
    const row = item as Record<string, unknown>
    const remotePort = Number(row.remotePort)
    const localPort = Number(row.localPort)
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535
      || !Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
      throw new SshWorkspaceValidationError('保存的端口转发端口无效')
    }
    return {
      remoteHost: text(row.remoteHost, '远端转发地址', 253),
      remotePort,
      localHost: text(row.localHost, '本地转发地址', 253),
      localPort,
    }
  })
}

function parseProfile(value: unknown): SshWorkspaceProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SshWorkspaceValidationError('保存的远程工作区条目格式无效')
  }
  const input = value as Record<string, unknown>
  const id = text(input.id, '连接 ID', 96)
  if (!/^ssh-[a-f0-9-]{36}$/u.test(id)) throw new SshWorkspaceValidationError('保存的连接 ID 无效')
  const pollIntervalMs = Number(input.pollIntervalMs)
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 2_000 || pollIntervalMs > 60_000) {
    throw new SshWorkspaceValidationError('保存的同步间隔无效')
  }
  const workspaceId = input.workspaceId === undefined ? undefined : text(input.workspaceId, '工作区 ID', 128)
  const terminalGraceSeconds = input.terminalGraceSeconds === undefined
    ? DEFAULT_TERMINAL_GRACE_SECONDS
    : Number(input.terminalGraceSeconds)
  if (!Number.isInteger(terminalGraceSeconds)
    || terminalGraceSeconds < MIN_TERMINAL_GRACE_SECONDS
    || terminalGraceSeconds > MAX_TERMINAL_GRACE_SECONDS) {
    throw new SshWorkspaceValidationError('保存的远程终端保留时间无效')
  }
  return {
    id,
    name: text(input.name, '名称', 80),
    host: normalizeHost(input.host),
    port: normalizePort(input.port),
    username: text(input.username, '用户名', 128),
    remotePath: normalizeRemotePath(input.remotePath),
    cachePath: assertCachePath(text(input.cachePath, '缓存目录', 4_096)),
    // Profiles written before direct mode existed are intentionally kept in
    // mirror mode. This avoids silently changing established workflows.
    workspaceMode: normalizeWorkspaceMode(input.workspaceMode, 'mirror'),
    hostFingerprint: normalizeFingerprint(input.hostFingerprint, true) as string,
    authMode: normalizeAuthMode(input.authMode),
    transportMode: normalizeTransportMode(input.transportMode),
    ...(normalizeOpenSshHost(input.openSshHost) === undefined
      ? {}
      : { openSshHost: normalizeOpenSshHost(input.openSshHost) }),
    helperMode: normalizeHelperMode(input.helperMode),
    terminalGraceSeconds,
    portForwards: parsePortForwards(input.portForwards),
    pollIntervalMs,
    excludes: normalizeExcludes(input.excludes),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    createdAt: isoTime(input.createdAt, '创建时间'),
    updatedAt: isoTime(input.updatedAt, '更新时间'),
  }
}

function parseDocument(value: unknown): ProfileDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SshWorkspaceValidationError('远程工作区配置文件必须是 JSON 对象')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.profiles)) {
    throw new SshWorkspaceValidationError('远程工作区配置文件版本不受支持')
  }
  const profiles = record.profiles.map(parseProfile)
  const ids = new Set<string>()
  const caches = new Set<string>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new SshWorkspaceValidationError(`连接 ID 重复：${profile.id}`)
    const cacheKey = process.platform === 'win32' ? profile.cachePath.toLowerCase() : profile.cachePath
    if (caches.has(cacheKey)) throw new SshWorkspaceValidationError(`缓存目录重复：${profile.cachePath}`)
    ids.add(profile.id)
    caches.add(cacheKey)
  }
  return { version: 1, profiles }
}

/** Durable, secret-free profile registry. Writes are serialized and atomic. */
export class SshProfileStore {
  readonly directory: string
  readonly filename: string
  readonly manifestDirectory: string
  readonly cacheDirectory: string
  private loaded = false
  private profiles = new Map<string, SshWorkspaceProfile>()
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly home: string) {
    this.directory = join(home, 'ssh-workspaces')
    this.filename = join(this.directory, 'profiles.json')
    this.manifestDirectory = join(this.directory, 'manifests')
    this.cacheDirectory = join(home, 'remote-workspaces')
  }

  async list(): Promise<readonly SshWorkspaceProfile[]> {
    await this.ensureLoaded()
    return [...this.profiles.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async get(id: string): Promise<SshWorkspaceProfile | undefined> {
    await this.ensureLoaded()
    return this.profiles.get(id)
  }

  cachePath(id: string): string {
    return join(this.cacheDirectory, id, 'root')
  }

  manifestPath(id: string): string {
    return join(this.manifestDirectory, `${id}.json`)
  }

  async put(profile: SshWorkspaceProfile): Promise<void> {
    await this.mutate((profiles) => { profiles.set(profile.id, profile) })
  }

  async delete(id: string): Promise<SshWorkspaceProfile | undefined> {
    let deleted: SshWorkspaceProfile | undefined
    await this.mutate((profiles) => {
      deleted = profiles.get(id)
      profiles.delete(id)
    })
    return deleted
  }

  async deleteManifest(id: string): Promise<void> {
    await rm(this.manifestPath(id), { force: true })
  }

  newId(): string {
    return `ssh-${randomUUID()}`
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.directory, { recursive: true })
    await mkdir(this.manifestDirectory, { recursive: true })
    await mkdir(this.cacheDirectory, { recursive: true })
    let raw: string
    try {
      raw = await readFile(this.filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      return
    }
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new SshWorkspaceValidationError(`远程工作区配置文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    const document = parseDocument(value)
    this.profiles = new Map(document.profiles.map(profile => [profile.id, profile]))
    this.loaded = true
  }

  private async mutate(operation: (profiles: Map<string, SshWorkspaceProfile>) => void): Promise<void> {
    const run = this.tail.then(async () => {
      await this.ensureLoaded()
      const next = new Map(this.profiles)
      operation(next)
      await this.write([...next.values()])
      this.profiles = next
    })
    this.tail = run.then(() => {}, () => {})
    return await run
  }

  private async write(profiles: readonly SshWorkspaceProfile[]): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temporary = join(this.directory, `.profiles-${process.pid}-${randomUUID()}.tmp`)
    const body = `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, this.filename)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}
