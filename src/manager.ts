import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import type { ClientChannel } from 'ssh2'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { SshCredentialStore } from './credentials.ts'
import { SshProfileStore } from './profile-store.ts'
import {
  connectionSpec,
  execSshCommand,
  openSshConnection,
  sftpRealpath,
  sftpStat,
} from './ssh-client.ts'
import {
  openRemoteHelperSession,
  parseJsonLines,
  profileConnectionInput,
  RemoteHelperSession,
} from './remote-helper.ts'
import { execSystemSshCommand, probeSystemSsh } from './system-ssh.ts'
import { startRemoteFileWatch, type RemoteFileWatch } from './remote-watch.ts'
import {
  PersistentRemoteTerminal,
  SystemSshRemoteTerminal,
} from './persistent-terminal.ts'
import { openPortForward, type ManagedPortForward } from './port-forward.ts'
import { SshConnectionPool } from './connection-pool.ts'
import { DirectRemoteFiles } from './remote-files.ts'
import {
  resolveSshConflict,
  SshBulkDeletionError,
  syncSshWorkspace,
  type ConflictResolution,
} from './sync-engine.ts'
import type {
  SafeSshProfile,
  SshCredentialPayload,
  SshProbeResult,
  SshProfileInput,
  SshDetectedPort,
  SshPortForward,
  SshWorkspaceProfile,
  SshWorkspaceStatus,
  SshRemoteFileRead,
  SshRemoteFileRevision,
  SshRemoteFileStat,
} from './types.ts'
import { normalizeProfileInput, SshWorkspaceValidationError } from './validation.ts'

const TERMINALS_PER_SESSION = 4
const TERMINAL_TRANSCRIPT_LIMIT = 1024 * 1024
const MAX_BACKGROUND_BACKOFF_MS = 5 * 60_000

interface WorkspaceRegistryFace extends Pick<WorkspaceRegistry, 'create' | 'resolveByPath' | 'delete'> {}

interface ManagedProfile {
  status: SshWorkspaceStatus
  interval?: ReturnType<typeof setInterval>
  watcher?: FSWatcher
  remoteWatcher?: RemoteFileWatch
  debounce?: ReturnType<typeof setTimeout>
  tail: Promise<void>
  activeSync?: Promise<void>
  syncing: boolean
  suppressWatchUntil: number
  failureCount: number
  retryNotBefore: number
  changeSequence: number
}

export interface RemoteTerminalSubscription { dispose(): void }

export interface RemoteTerminalHandle {
  readonly key: string
  readonly title: string
  readonly sessionId: string
  readonly tabId: string
  readonly cwd: string
  readonly transcript: string
  readonly exited: boolean
  readonly exitCode?: number | null
  readonly persistent?: boolean
  onData(listener: (data: string) => void): RemoteTerminalSubscription
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): RemoteTerminalSubscription
  write(data: string): void
  resize(cols: number, rows: number): void
}

interface ManagedTerminal extends RemoteTerminalHandle {
  close(): void
  detach(): void
}

class RemoteTerminal implements RemoteTerminalHandle {
  transcript = ''
  exited = false
  exitCode: number | null | undefined
  readonly persistent = false
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  constructor(
    readonly key: string,
    readonly title: string,
    readonly sessionId: string,
    readonly tabId: string,
    readonly cwd: string,
    private readonly channel: ClientChannel,
    private readonly closeConnection: () => void,
  ) {
    channel.on('data', (chunk: Buffer | string) => this.emit(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk))
    channel.stderr.on('data', (chunk: Buffer | string) => this.emit(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk))
    channel.once('close', (exitCode: number | null, signal?: string | number) => {
      this.exited = true
      this.exitCode = exitCode
      this.closeConnection()
      const event = { exitCode: exitCode ?? 0, ...(typeof signal === 'number' ? { signal } : {}) }
      for (const listener of this.exitListeners) listener(event)
    })
    channel.once('error', (error: Error) => this.emit(`\r\n[远程终端错误：${error.message}]\r\n`))
  }

  onData(listener: (data: string) => void): RemoteTerminalSubscription {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): RemoteTerminalSubscription {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(data: string): void {
    if (!this.exited) this.channel.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.channel.setWindow(Math.max(2, Math.floor(rows)), Math.max(2, Math.floor(cols)), 0, 0)
  }

  close(): void {
    if (this.exited) return
    this.exited = true
    try { this.channel.close() } catch { /* already closed */ }
    this.closeConnection()
  }

  detach(): void { this.close() }

  private emit(data: string): void {
    this.transcript += data
    if (this.transcript.length > TERMINAL_TRANSCRIPT_LIMIT) {
      this.transcript = this.transcript.slice(this.transcript.length - TERMINAL_TRANSCRIPT_LIMIT)
    }
    for (const listener of this.dataListeners) listener(data)
  }
}

function homeDirectory(): string {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : resolve(homedir(), '.dsh')
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // `ssh2` never intentionally includes the supplied password/key, but keep
  // UI diagnostics bounded and free of accidental long remote banners.
  return text.replace(/[\r\n]+/gu, ' ').slice(0, 500)
}

function unavailablePortForward(
  value: Omit<SshPortForward, 'state' | 'lastError'>,
  error: unknown,
): ManagedPortForward {
  return {
    value: { ...value, state: 'error', lastError: errorText(error) },
    async close() {},
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export class SshWorkspaceManager {
  readonly profiles: SshProfileStore
  readonly credentials: SshCredentialStore
  private readonly managed = new Map<string, ManagedProfile>()
  private readonly terminals = new Map<string, ManagedTerminal>()
  private readonly terminalCloses = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly portForwards = new Map<string, ManagedPortForward>()
  private readonly connectionPool = new SshConnectionPool()
  private readonly directSessions = new Map<string, Promise<RemoteHelperSession>>()

  constructor(
    credentials: CredentialProvider,
    private readonly workspaceRegistry: WorkspaceRegistryFace,
    home = homeDirectory(),
    private readonly log: (message: string) => void = () => {},
  ) {
    this.profiles = new SshProfileStore(home)
    this.credentials = new SshCredentialStore(credentials)
  }

  async bootstrap(): Promise<void> {
    for (const profile of await this.profiles.list()) {
      this.state(profile.id)
      if (profile.workspaceMode === 'direct') {
        void this.ensureDirectWatch(profile.id).catch(error => this.log(
          `[dsh-ssh-workspace] 无法启动远程文件监听：${errorText(error)}`,
        ))
      } else {
        void this.ensureBackgroundSync(profile.id).catch(error => this.log(
          `[dsh-ssh-workspace] 无法启动后台同步：${errorText(error)}`,
        ))
      }
      void this.restorePortForwards(profile).catch(error => this.log(
        `[dsh-ssh-workspace] 无法恢复端口转发：${errorText(error)}`,
      ))
    }
  }

  dispose(): void {
    for (const state of this.managed.values()) this.disposeState(state)
    this.managed.clear()
    for (const timer of this.terminalCloses.values()) clearTimeout(timer)
    this.terminalCloses.clear()
    for (const terminal of this.terminals.values()) terminal.detach()
    this.terminals.clear()
    for (const forward of this.portForwards.values()) void forward.close()
    this.portForwards.clear()
    this.connectionPool.dispose()
    for (const session of this.directSessions.values()) void session.then(value => value.dispose(), () => {})
    this.directSessions.clear()
  }

  async list(): Promise<readonly SafeSshProfile[]> {
    const profiles = await this.profiles.list()
    return await Promise.all(profiles.map(async (profile) => await this.safeProfile(profile)))
  }

  async probe(input: SshProfileInput): Promise<SshProbeResult> {
    const normalized = normalizeProfileInput(input, false)
    const existing = normalized.id === undefined ? undefined : await this.profiles.get(normalized.id)
    const credential = await this.credentialForInput(normalized, existing)
    const system = normalized.transportMode === 'system'
      || normalized.authMode === 'openssh-config'
      || normalized.openSshHost !== undefined
    const systemProbe = system ? await probeSystemSsh(normalized) : undefined
    if (normalized.hostFingerprint !== undefined
      && systemProbe !== undefined
      && systemProbe.fingerprint !== normalized.hostFingerprint) {
      throw new SshWorkspaceValidationError(
        `服务器主机指纹已变化：期望 ${normalized.hostFingerprint}，实际 ${systemProbe.fingerprint}`,
      )
    }
    const session = await RemoteHelperSession.open(profileConnectionInput(normalized), credential)
    try {
      let remoteRealPath: string
      if (session.kind === 'builtin') {
        if (session.sftp === undefined) throw new SshWorkspaceValidationError('服务器没有提供 SFTP，无法建立同步工作区')
        remoteRealPath = await sftpRealpath(session.sftp, normalized.remotePath)
        const info = await sftpStat(session.sftp, remoteRealPath)
        if (info?.kind !== 'directory') throw new SshWorkspaceValidationError(`远程目录不可用：${normalized.remotePath}`)
      } else {
        const resolved = await session.exec(['realpath', normalized.remotePath])
        if (resolved.exitCode !== 0) throw new SshWorkspaceValidationError(`远程目录不可用：${normalized.remotePath}`)
        const value = JSON.parse(resolved.stdout.toString('utf8').trim()) as { path?: unknown }
        if (typeof value.path !== 'string') throw new SshWorkspaceValidationError('远端助手没有返回有效目录')
        remoteRealPath = value.path
      }
      return {
        ok: true,
        fingerprint: systemProbe?.fingerprint ?? session.connection?.fingerprint ?? '',
        remotePath: normalized.remotePath,
        remoteRealPath,
        ...(systemProbe?.serverBanner === undefined && session.connection?.serverBanner === undefined
          ? {}
          : { serverBanner: systemProbe?.serverBanner ?? session.connection?.serverBanner }),
        capabilities: session.capabilities,
      }
    } finally {
      session.dispose()
    }
  }

  /** Save credentials/profile only after the supplied host key was successfully verified, then create the DSH Workspace. */
  async saveAndCreate(input: SshProfileInput): Promise<SafeSshProfile> {
    const preliminary = normalizeProfileInput(input, false)
    const existing = preliminary.id === undefined ? undefined : await this.profiles.get(preliminary.id)
    const fingerprint = preliminary.hostFingerprint ?? existing?.hostFingerprint
    if (fingerprint === undefined) throw new SshWorkspaceValidationError('请先测试连接并确认服务器主机指纹')
    const normalized = normalizeProfileInput({ ...input, hostFingerprint: fingerprint }, true)
    const id = normalized.id ?? this.profiles.newId()
    const credential = await this.credentialForInput(normalized, existing)
    const probe = await this.probe({ ...normalized, id })
    if (probe.fingerprint !== normalized.hostFingerprint) {
      throw new SshWorkspaceValidationError('测试连接返回的主机指纹与确认值不一致')
    }
    if (normalized.authMode !== 'agent' && normalized.authMode !== 'openssh-config') {
      if (credential === undefined) throw new SshWorkspaceValidationError('未找到可用的 SSH 凭据')
      await this.credentials.write(id, credential)
    }
    this.connectionPool.invalidate(id)
    const now = new Date().toISOString()
    const profile: SshWorkspaceProfile = {
      id,
      name: normalized.name,
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      remotePath: probe.remoteRealPath,
      cachePath: existing?.cachePath ?? this.profiles.cachePath(id),
      workspaceMode: normalized.workspaceMode,
      hostFingerprint: probe.fingerprint,
      authMode: normalized.authMode,
      transportMode: normalized.transportMode,
      ...(normalized.openSshHost === undefined ? {} : { openSshHost: normalized.openSshHost }),
      helperMode: normalized.helperMode,
      terminalGraceSeconds: normalized.terminalGraceSeconds,
      portForwards: existing?.portForwards ?? [],
      pollIntervalMs: normalized.pollIntervalMs,
      excludes: normalized.excludes,
      ...(existing?.workspaceId === undefined ? {} : { workspaceId: existing.workspaceId }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await mkdir(profile.cachePath, { recursive: true })
    if (profile.workspaceMode === 'direct') {
      await writeFile(
        resolve(profile.cachePath, '.dsh-remote-workspace.json'),
        `${JSON.stringify({ version: 1, profileId: profile.id, remotePath: profile.remotePath }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    }
    await this.profiles.put(profile)
    this.disposeDirectSession(id)
    this.state(id).status = {
      ...this.state(id).status,
      phase: profile.workspaceMode === 'direct' ? 'ready' : this.state(id).status.phase,
      connected: false,
      availability: 'live',
      capabilities: probe.capabilities,
      lastError: undefined,
    }
    if (profile.workspaceMode === 'mirror') await this.syncOrThrow(id)
    const current = await this.profiles.get(id) as SshWorkspaceProfile
    const workspace = await this.workspaceRegistry.resolveByPath(current.cachePath) ?? await this.workspaceRegistry.create(current.cachePath, current.name)
    if (workspace.title !== current.name) await workspace.setTitle(current.name)
    const complete: SshWorkspaceProfile = { ...current, workspaceId: workspace.id, updatedAt: new Date().toISOString() }
    await this.profiles.put(complete)
    if (complete.workspaceMode === 'direct') {
      const state = this.state(id)
      if (state.interval !== undefined) { clearInterval(state.interval); state.interval = undefined }
      state.watcher?.close(); state.watcher = undefined
      if (existing !== undefined && state.remoteWatcher !== undefined) { state.remoteWatcher.close(); state.remoteWatcher = undefined }
      await this.ensureDirectWatch(id)
    } else {
      await this.ensureBackgroundSync(id, {
        resetInterval: existing !== undefined && existing.pollIntervalMs !== complete.pollIntervalMs,
        resetRemoteWatch: existing !== undefined,
        syncNow: false,
      })
    }
    return await this.safeProfile(complete)
  }

  async sync(id: string, options: { readonly allowBulkDelete?: boolean } = {}): Promise<SshWorkspaceStatus> {
    const profile = await this.profiles.get(id)
    if (profile?.workspaceMode === 'direct') {
      await this.ensureDirectWatch(id)
      const state = this.state(id)
      state.changeSequence += 1
      state.status = { ...state.status, phase: 'ready', availability: 'live', connected: false, lastError: undefined }
      return state.status
    }
    try {
      await this.syncOrThrow(id, options)
    } catch (error) {
      const state = this.state(id)
      if (state.status.phase !== 'error') {
        state.status = { ...state.status, phase: 'error', lastError: errorText(error), connected: false }
      }
      this.log(`[dsh-ssh-workspace] 同步失败：${errorText(error)}`)
    }
    const state = this.state(id)
    if (state.status.phase !== 'error') {
      state.failureCount = 0
      state.retryNotBefore = 0
    }
    return this.state(id).status
  }

  async resolveConflict(id: string, path: string, strategy: ConflictResolution): Promise<SshWorkspaceStatus> {
    if (strategy !== 'local' && strategy !== 'remote') throw new SshWorkspaceValidationError('冲突解决方式无效')
    const state = this.state(id)
    const next = state.tail.then(async () => {
      const profile = await this.profiles.get(id)
      if (profile === undefined) throw new SshWorkspaceValidationError('远程工作区不存在')
      if (profile.workspaceMode === 'direct') throw new SshWorkspaceValidationError('远程直连模式没有本地同步冲突')
      const credential = await this.credentials.read(id)
      const system = profile.transportMode === 'system' || profile.authMode === 'openssh-config' || profile.openSshHost !== undefined
      const lease = system ? undefined : await this.connectionPool.acquire(profile, credential)
      let manifest: Awaited<ReturnType<typeof resolveSshConflict>>
      try {
        manifest = await resolveSshConflict(
          profile,
          credential,
          this.profiles.manifestPath(id),
          path,
          strategy,
          lease?.connection,
        )
      } finally {
        lease?.release()
      }
      state.suppressWatchUntil = Date.now() + 1_500
      state.status = {
        ...state.status,
        phase: Object.keys(manifest.conflicts).length === 0 ? 'ready' : 'conflict',
        conflictCount: Object.keys(manifest.conflicts).length,
        conflicts: Object.values(manifest.conflicts).map(conflict => ({
          path: conflict.path,
          remoteDeleted: conflict.remoteDeleted,
          ...(conflict.copyPath === undefined ? {} : { copyPath: conflict.copyPath }),
          detectedAt: conflict.detectedAt,
        })),
        lastError: undefined,
      }
    })
    state.tail = next.then(() => {}, () => {})
    await next
    return state.status
  }

  async delete(id: string): Promise<void> {
    const profile = await this.profiles.delete(id)
    const state = this.managed.get(id)
    if (state !== undefined) {
      this.disposeState(state)
      this.managed.delete(id)
    }
    for (const [key, terminal] of this.terminals) {
      if (profile !== undefined && contained(resolve(profile.cachePath), resolve(terminal.cwd))) {
        terminal.close()
        this.terminals.delete(key)
      }
    }
    for (const [key, forward] of this.portForwards) {
      if (forward.value.profileId !== id) continue
      await forward.close()
      this.portForwards.delete(key)
    }
    await this.credentials.delete(id)
    this.connectionPool.invalidate(id)
    this.disposeDirectSession(id)
    if (profile?.workspaceId !== undefined) await this.workspaceRegistry.delete(profile.workspaceId as never)
    // Cache and manifest intentionally remain: profile removal must never
    // delete a user's working files. A later re-add with a new id starts fresh.
  }

  /** Explicitly remove legacy mirror contents after a profile switches to direct mode. */
  async clearDirectCache(id: string): Promise<number> {
    const profile = await this.profiles.get(id)
    if (profile === undefined) throw new SshWorkspaceValidationError('远程工作区不存在')
    if (profile.workspaceMode !== 'direct') throw new SshWorkspaceValidationError('只有远程直连工作区可以清理旧镜像缓存')
    const root = resolve(profile.cachePath)
    if (!contained(resolve(this.profiles.cacheDirectory), root)) {
      throw new SshWorkspaceValidationError('缓存目录不在 DSH 远程工作区目录内，拒绝自动清理')
    }
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    let removed = 0
    for (const entry of entries) {
      if (entry.name === '.dsh-remote-workspace.json') continue
      await rm(resolve(root, entry.name), { recursive: true, force: true })
      removed += 1
    }
    return removed
  }

  async findByCachePath(cwd: string): Promise<SshWorkspaceProfile | undefined> {
    const resolvedCwd = resolve(cwd)
    const candidates = (await this.profiles.list())
      .filter(profile => contained(resolve(profile.cachePath), resolvedCwd))
      .sort((left, right) => right.cachePath.length - left.cachePath.length)
    return candidates[0]
  }

  /** Resolve a direct-mode workspace by its tiny local marker path. */
  async findDirectByCachePath(cwd: string): Promise<SshWorkspaceProfile | undefined> {
    const profile = await this.findByCachePath(cwd)
    return profile?.workspaceMode === 'direct' ? profile : undefined
  }

  async listRemoteDirectory(cwd: string, path: string, maximumEntries: number) {
    return await (await this.directFilesForPath(cwd)).list(path, maximumEntries)
  }

  async searchRemoteFiles(cwd: string, query: string, maximumEntries: number) {
    return await (await this.directFilesForPath(cwd)).search(query, maximumEntries)
  }

  async statRemoteFile(cwd: string, path: string): Promise<SshRemoteFileStat> {
    return await (await this.directFilesForPath(cwd)).stat(path)
  }

  async readRemoteFile(cwd: string, path: string, maximumBytes: number, signal?: AbortSignal): Promise<SshRemoteFileRead> {
    return await (await this.directFilesForPath(cwd)).read(path, maximumBytes, signal)
  }

  async readRemoteRange(cwd: string, path: string, start: number, length: number, signal?: AbortSignal) {
    return await (await this.directFilesForPath(cwd)).readRange(path, start, length, signal)
  }

  async writeRemoteFile(
    cwd: string,
    path: string,
    bytes: Uint8Array,
    expectedRevision?: string,
  ): Promise<SshRemoteFileRevision> {
    const files = await this.directFilesForPath(cwd)
    const revision = await files.write(path, bytes, expectedRevision)
    this.bumpRemoteChanges(files.profile.id)
    return revision
  }

  async createRemoteDirectory(cwd: string, path: string): Promise<void> {
    const files = await this.directFilesForPath(cwd)
    await files.mkdir(path)
    this.bumpRemoteChanges(files.profile.id)
  }

  async removeRemotePath(cwd: string, path: string, recursive = false): Promise<void> {
    const files = await this.directFilesForPath(cwd)
    await files.remove(path, recursive)
    this.bumpRemoteChanges(files.profile.id)
  }

  async renameRemotePath(cwd: string, from: string, to: string): Promise<void> {
    const files = await this.directFilesForPath(cwd)
    await files.rename(from, to)
    this.bumpRemoteChanges(files.profile.id)
  }

  async remoteChangesForCachePath(cwd: string): Promise<{ sequence: number; available: boolean } | undefined> {
    const profile = await this.findDirectByCachePath(cwd)
    if (profile === undefined) return undefined
    const state = this.state(profile.id)
    await this.ensureDirectWatch(profile.id)
    return { sequence: state.changeSequence, available: state.remoteWatcher !== undefined }
  }

  listPortForwards(profileId?: string): readonly SshPortForward[] {
    return [...this.portForwards.values()]
      .map(forward => forward.value)
      .filter(forward => profileId === undefined || forward.profileId === profileId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async detectPorts(profileId: string): Promise<readonly SshDetectedPort[]> {
    const profile = await this.profiles.get(profileId)
    if (profile === undefined) throw new SshWorkspaceValidationError('远程工作区不存在')
    const credential = await this.credentials.read(profile.id)
    const helper = await openRemoteHelperSession(profile, credential)
    try {
      if (helper.helper === undefined) throw new SshWorkspaceValidationError('远端助手不可用，无法自动发现端口')
      const result = await helper.exec(['ports'])
      if (result.exitCode !== 0) throw new SshWorkspaceValidationError('远端端口发现失败')
      const unique = new Map<string, SshDetectedPort>()
      for (const row of parseJsonLines<{ host?: unknown; port?: unknown; process?: unknown }>(result.stdout)) {
        if (typeof row.host !== 'string' || !Number.isInteger(row.port) || Number(row.port) < 1 || Number(row.port) > 65_535) continue
        const value: SshDetectedPort = {
          host: row.host,
          port: Number(row.port),
          ...(typeof row.process === 'string' ? { process: row.process } : {}),
        }
        unique.set(`${value.host}:${String(value.port)}`, value)
      }
      return [...unique.values()].sort((left, right) => left.port - right.port)
    } finally {
      helper.dispose()
    }
  }

  async addPortForward(
    profileId: string,
    remotePort: number,
    localPort?: number,
    remoteHost = '127.0.0.1',
  ): Promise<SshPortForward> {
    const profile = await this.profiles.get(profileId)
    if (profile === undefined) throw new SshWorkspaceValidationError('远程工作区不存在')
    const credential = await this.credentials.read(profile.id)
    const forward = await openPortForward(profile, credential, { remoteHost, remotePort, localPort })
    this.portForwards.set(forward.value.id, forward)
    await this.persistPortForwards(profileId)
    return forward.value
  }

  async removePortForward(id: string): Promise<void> {
    const forward = this.portForwards.get(id)
    if (forward === undefined) return
    const profileId = forward.value.profileId
    this.portForwards.delete(id)
    await forward.close()
    await this.persistPortForwards(profileId)
  }

  async restartPortForward(id: string): Promise<SshPortForward> {
    const previous = this.portForwards.get(id)
    if (previous === undefined) throw new SshWorkspaceValidationError('端口转发不存在或已经被清理')
    const snapshot = previous.value
    const profile = await this.profiles.get(snapshot.profileId)
    if (profile === undefined) throw new SshWorkspaceValidationError('远程工作区不存在')
    const credential = await this.credentials.read(profile.id)
    this.portForwards.delete(id)
    await previous.close()
    try {
      const replacement = await openPortForward(profile, credential, {
        remoteHost: snapshot.remoteHost,
        remotePort: snapshot.remotePort,
        localHost: snapshot.localHost,
        localPort: snapshot.localPort,
      })
      this.portForwards.set(replacement.value.id, replacement)
      await this.persistPortForwards(profile.id)
      return replacement.value
    } catch (error) {
      const failed = unavailablePortForward(snapshot, error)
      // Keep the saved intent visible and persistent even when the server is
      // still offline. The user can retry again without recreating the rule.
      this.portForwards.set(snapshot.id, failed)
      await this.persistPortForwards(profile.id)
      throw new SshWorkspaceValidationError(`端口转发重试失败：${errorText(error)}`)
    }
  }

  private async restorePortForwards(profile: SshWorkspaceProfile): Promise<void> {
    if (profile.portForwards.length === 0) return
    const credential = await this.credentials.read(profile.id)
    const retained = [] as SshWorkspaceProfile['portForwards'][number][]
    for (const spec of profile.portForwards) {
      try {
        const forward = await openPortForward(profile, credential, spec)
        this.portForwards.set(forward.value.id, forward)
        retained.push({
          remoteHost: forward.value.remoteHost,
          remotePort: forward.value.remotePort,
          localHost: forward.value.localHost,
          localPort: forward.value.localPort,
        })
      } catch (error) {
        // A temporary port collision or offline server must not silently
        // erase a user's saved forwarding intent. Retain it for the next
        // application start while reporting the runtime failure.
        retained.push(spec)
        const failed = unavailablePortForward({
          id: `forward-${randomUUID()}`,
          profileId: profile.id,
          remoteHost: spec.remoteHost,
          remotePort: spec.remotePort,
          localHost: spec.localHost,
          localPort: spec.localPort,
          createdAt: new Date().toISOString(),
        }, error)
        this.portForwards.set(failed.value.id, failed)
        this.log(`[dsh-ssh-workspace] 端口 ${String(spec.remotePort)} 恢复失败：${errorText(error)}`)
      }
    }
    await this.profiles.put({ ...profile, portForwards: retained, updatedAt: new Date().toISOString() })
  }

  private async persistPortForwards(profileId: string): Promise<void> {
    const profile = await this.profiles.get(profileId)
    if (profile === undefined) return
    const portForwards = this.listPortForwards(profileId).map(forward => ({
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort,
      localHost: forward.localHost,
      localPort: forward.localPort,
    }))
    await this.profiles.put({ ...profile, portForwards, updatedAt: new Date().toISOString() })
  }

  async executeForCachePath(cwd: string, command: string, signal?: AbortSignal): Promise<{
    profile: SshWorkspaceProfile
    stdout: string
    stderr: string
    exitCode: number | null
    signal?: string
  }> {
    if (command.trim() === '') throw new SshWorkspaceValidationError('远程命令不能为空')
    if (command.length > 32_000) throw new SshWorkspaceValidationError('远程命令过长')
    const profile = await this.findByCachePath(cwd)
    if (profile === undefined) throw new SshWorkspaceValidationError('当前工作区不是 SSH 远程工作区')
    const credential = await this.credentials.read(profile.id)
    const remoteCwd = this.remoteCwd(profile, cwd)
    if (profile.transportMode === 'system' || profile.authMode === 'openssh-config' || profile.openSshHost !== undefined) {
      const result = await execSystemSshCommand(profile, remoteCwd, command, signal)
      return { profile, ...result }
    }
    const lease = await this.connectionPool.acquire(profile, credential)
    try {
      const result = await execSshCommand(lease.connection.client, remoteCwd, command, signal)
      return { profile, ...result }
    } finally {
      lease.release()
    }
  }

  /** Host seam consumed by the side-card terminal. Undefined means local workspace. */
  async openTerminal(sessionId: string, tabId: string, cwd: string, cols: number, rows: number): Promise<RemoteTerminalHandle | undefined> {
    const profile = await this.findByCachePath(cwd)
    if (profile === undefined) return undefined
    const key = `${sessionId}:${tabId}`
    this.cancelTerminalClose(key)
    const existing = this.terminals.get(key)
    if (existing !== undefined && !existing.exited && existing.cwd === cwd) return existing
    if (existing !== undefined) this.closeTerminal(key)
    const openForSession = [...this.terminals.values()].filter(item => item.sessionId === sessionId && !item.exited)
    if (openForSession.length >= TERMINALS_PER_SESSION) {
      throw new SshWorkspaceValidationError(`远程终端数量已达到上限（每个会话 ${TERMINALS_PER_SESSION} 个）`)
    }
    const credential = await this.credentials.read(profile.id)
    const remoteCwd = this.remoteCwd(profile, cwd)
    const persistent = await PersistentRemoteTerminal.open({
      key,
      title: `SSH · ${profile.name}`,
      sessionId,
      tabId,
      cwd,
      profile,
      ...(credential === undefined ? {} : { credential }),
      remoteCwd,
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
    })
    if (persistent !== undefined) {
      this.terminals.set(key, persistent)
      return persistent
    }
    if (profile.transportMode === 'system' || profile.authMode === 'openssh-config' || profile.openSshHost !== undefined) {
      const terminal = await SystemSshRemoteTerminal.open({
        key,
        title: `SSH · ${profile.name}`,
        sessionId,
        tabId,
        cwd,
        profile,
        remoteCwd,
      })
      this.terminals.set(key, terminal)
      return terminal
    }
    const connection = await openSshConnection(connectionSpec(profile, credential))
    try {
      const channel = await new Promise<ClientChannel>((resolveChannel, reject) => {
        connection.client.shell({ term: 'xterm-256color', cols: Math.max(2, cols), rows: Math.max(2, rows) }, (error, stream) => {
          if (error !== undefined) reject(error)
          else resolveChannel(stream)
        })
      })
      const terminal = new RemoteTerminal(key, `SSH · ${profile.name}`, sessionId, tabId, cwd, channel, () => {
        connection.dispose()
        if (this.terminals.get(key) === terminal) this.terminals.delete(key)
      })
      this.terminals.set(key, terminal)
      channel.write(`cd -- ${shellQuote(remoteCwd)}\n`)
      return terminal
    } catch (error) {
      connection.dispose()
      throw error
    }
  }

  scheduleTerminalClose(key: string, delayMs: number): void {
    const terminal = this.terminals.get(key)
    if (terminal === undefined) return
    this.cancelTerminalClose(key)
    const timer = setTimeout(() => {
      this.terminalCloses.delete(key)
      const current = this.terminals.get(key)
      if (current === undefined) return
      this.terminals.delete(key)
      current.detach()
    }, Math.max(0, delayMs))
    this.terminalCloses.set(key, timer)
  }

  closeTerminal(key: string): void {
    this.cancelTerminalClose(key)
    const terminal = this.terminals.get(key)
    if (terminal === undefined) return
    this.terminals.delete(key)
    terminal.close()
  }

  private async safeProfile(profile: SshWorkspaceProfile): Promise<SafeSshProfile> {
    return {
      ...profile,
      credentialConfigured: await this.credentials.configured(
        profile.id,
        profile.authMode,
        profile.transportMode === 'system' || profile.openSshHost !== undefined,
      ),
      status: this.state(profile.id).status,
    }
  }

  private state(profileId: string): ManagedProfile {
    let state = this.managed.get(profileId)
    if (state !== undefined) return state
    state = {
      status: {
        profileId,
        phase: 'idle',
        conflictCount: 0,
        filesPulled: 0,
        filesPushed: 0,
        connected: false,
        availability: 'unverifiable',
        conflicts: [],
      },
      tail: Promise.resolve(),
      syncing: false,
      suppressWatchUntil: 0,
      failureCount: 0,
      retryNotBefore: 0,
      changeSequence: 0,
    }
    this.managed.set(profileId, state)
    return state
  }

  private async syncOrThrow(id: string, options: { readonly allowBulkDelete?: boolean } = {}): Promise<void> {
    const state = this.state(id)
    if (state.activeSync !== undefined) {
      await state.activeSync
      if (options.allowBulkDelete === true && state.status.deletionGuard !== undefined) {
        return await this.syncOrThrow(id, options)
      }
      return
    }
    const next = state.tail.then(async () => {
      const profile = await this.profiles.get(id)
      if (profile === undefined) throw new SshWorkspaceValidationError('远程工作区不存在')
      if (profile.workspaceMode === 'direct') throw new SshWorkspaceValidationError('远程直连模式不执行全量同步')
      state.syncing = true
      state.status = {
        ...state.status,
        phase: 'syncing',
        lastError: undefined,
        nextRetryAt: undefined,
        deletionGuard: undefined,
        connected: true,
        availability: 'live',
      }
      try {
        const credential = await this.credentials.read(profile.id)
        if (!await this.credentials.configured(
          profile.id,
          profile.authMode,
          profile.transportMode === 'system' || profile.openSshHost !== undefined,
        )) {
          throw new SshWorkspaceValidationError('SSH 凭据尚未配置，请在远程工作区设置中补充')
        }
        const system = profile.transportMode === 'system' || profile.authMode === 'openssh-config' || profile.openSshHost !== undefined
        const lease = system ? undefined : await this.connectionPool.acquire(profile, credential)
        let report: Awaited<ReturnType<typeof syncSshWorkspace>>
        try {
          report = await syncSshWorkspace(
            profile,
            credential,
            this.profiles.manifestPath(profile.id),
            options,
            lease?.connection,
          )
        } finally {
          lease?.release()
        }
        state.suppressWatchUntil = Date.now() + 1_500
        state.status = {
          profileId: profile.id,
          phase: report.conflicts.length === 0 ? 'ready' : 'conflict',
          lastSyncAt: report.completedAt,
          conflictCount: report.conflicts.length,
          filesPulled: report.filesPulled,
          filesPushed: report.filesPushed,
          connected: false,
          availability: 'live',
          nextRetryAt: undefined,
          deletionGuard: undefined,
          conflicts: report.conflicts.map(conflict => ({
            path: conflict.path,
            remoteDeleted: conflict.remoteDeleted,
            ...(conflict.copyPath === undefined ? {} : { copyPath: conflict.copyPath }),
            detectedAt: conflict.detectedAt,
          })),
        }
        if (state.remoteWatcher === undefined && profile.helperMode !== 'disabled') {
          state.remoteWatcher = startRemoteFileWatch(profile, credential, {
            onChange: () => {
              if (state.syncing || Date.now() < state.suppressWatchUntil) return
              if (state.debounce !== undefined) clearTimeout(state.debounce)
              state.debounce = setTimeout(() => {
                state.debounce = undefined
                void this.runBackgroundSync(id)
              }, 250)
              state.debounce.unref?.()
            },
            onCapabilities: capabilities => {
              state.status = { ...state.status, capabilities }
            },
            onError: error => this.log(`[dsh-ssh-workspace] 远端实时监听暂时断开，继续使用轮询：${errorText(error)}`),
          })
        }
      } catch (error) {
        state.status = {
          ...state.status,
          phase: 'error',
          lastError: errorText(error),
          connected: false,
          availability: 'unverifiable',
          deletionGuard: error instanceof SshBulkDeletionError ? {
            candidateCount: error.candidateCount,
            trackedCount: error.trackedCount,
          } : undefined,
        }
        throw error
      } finally {
        state.syncing = false
      }
    })
    state.activeSync = next
    state.tail = next.then(() => {}, () => {})
    try {
      await next
    } finally {
      if (state.activeSync === next) state.activeSync = undefined
    }
  }

  private async ensureBackgroundSync(
    id: string,
    options: {
      readonly resetInterval?: boolean
      readonly resetRemoteWatch?: boolean
      readonly syncNow?: boolean
    } = {},
  ): Promise<void> {
    const profile = await this.profiles.get(id)
    if (profile === undefined) return
    if (profile.workspaceMode === 'direct') {
      await this.ensureDirectWatch(id)
      return
    }
    const state = this.state(id)
    if (options.resetInterval === true && state.interval !== undefined) {
      clearInterval(state.interval)
      state.interval = undefined
    }
    if (options.resetRemoteWatch === true && state.remoteWatcher !== undefined) {
      state.remoteWatcher.close()
      state.remoteWatcher = undefined
    }
    if (state.interval === undefined) {
      state.interval = setInterval(() => { void this.runBackgroundSync(id) }, profile.pollIntervalMs)
      state.interval.unref?.()
    }
    if (state.watcher === undefined) {
      await mkdir(profile.cachePath, { recursive: true })
      try {
        state.watcher = watch(profile.cachePath, { recursive: true }, () => {
          if (state.syncing || Date.now() < state.suppressWatchUntil) return
          if (state.debounce !== undefined) clearTimeout(state.debounce)
          state.debounce = setTimeout(() => { state.debounce = undefined; void this.runBackgroundSync(id) }, 750)
          state.debounce.unref?.()
        })
        state.watcher.on('error', (error) => this.log(`[dsh-ssh-workspace] 本地变更监听降级为轮询：${errorText(error)}`))
      } catch (error) {
        this.log(`[dsh-ssh-workspace] 无法监听本地缓存，继续使用轮询：${errorText(error)}`)
      }
    }
    if (options.syncNow !== false) void this.runBackgroundSync(id)
  }

  private async runBackgroundSync(id: string): Promise<void> {
    const state = this.state(id)
    if (state.status.deletionGuard !== undefined || Date.now() < state.retryNotBefore) return
    const profile = await this.profiles.get(id)
    if (profile === undefined) return
    const status = await this.sync(id)
    if (status.phase !== 'error' || status.deletionGuard !== undefined) return
    state.failureCount = Math.min(state.failureCount + 1, 10)
    const delay = Math.min(
      MAX_BACKGROUND_BACKOFF_MS,
      profile.pollIntervalMs * (2 ** Math.min(state.failureCount, 6)),
    )
    state.retryNotBefore = Date.now() + delay
    state.status = { ...state.status, nextRetryAt: new Date(state.retryNotBefore).toISOString() }
  }

  private disposeState(state: ManagedProfile): void {
    if (state.interval !== undefined) clearInterval(state.interval)
    if (state.debounce !== undefined) clearTimeout(state.debounce)
    state.watcher?.close()
    state.remoteWatcher?.close()
  }

  private async directFilesForPath(cwd: string): Promise<DirectRemoteFiles> {
    const profile = await this.findDirectByCachePath(cwd)
    if (profile === undefined) throw new SshWorkspaceValidationError('当前工作区不是 SSH 远程直连工作区')
    return new DirectRemoteFiles(profile, await this.directSession(profile))
  }

  private async directSession(profile: SshWorkspaceProfile): Promise<RemoteHelperSession> {
    let pending = this.directSessions.get(profile.id)
    if (pending !== undefined) return await pending
    pending = (async () => {
      const credential = await this.credentials.read(profile.id)
      const session = await openRemoteHelperSession(profile, credential)
      if (session.sftp === undefined && session.helper === undefined) {
        session.dispose()
        throw new SshWorkspaceValidationError('服务器既不支持 SFTP，也无法使用远端助手')
      }
      return session
    })()
    this.directSessions.set(profile.id, pending)
    try { return await pending } catch (error) {
      if (this.directSessions.get(profile.id) === pending) this.directSessions.delete(profile.id)
      throw error
    }
  }

  private disposeDirectSession(id: string): void {
    const pending = this.directSessions.get(id)
    this.directSessions.delete(id)
    if (pending !== undefined) void pending.then(session => session.dispose(), () => {})
  }

  private async ensureDirectWatch(id: string): Promise<void> {
    const profile = await this.profiles.get(id)
    if (profile === undefined || profile.workspaceMode !== 'direct') return
    const state = this.state(id)
    if (state.remoteWatcher !== undefined || profile.helperMode === 'disabled') return
    const credential = await this.credentials.read(profile.id)
    state.remoteWatcher = startRemoteFileWatch(profile, credential, {
      onChange: () => this.bumpRemoteChanges(id),
      onCapabilities: capabilities => {
        state.status = { ...state.status, capabilities, phase: 'ready', availability: 'live', lastError: undefined }
      },
      onError: error => {
        this.log(`[dsh-ssh-workspace] 远程实时监听暂时断开：${errorText(error)}`)
        state.status = { ...state.status, availability: 'unverifiable', lastError: errorText(error) }
      },
    })
  }

  private bumpRemoteChanges(id: string): void {
    const state = this.state(id)
    state.changeSequence += 1
    state.status = { ...state.status, phase: 'ready', availability: 'live', lastError: undefined }
  }

  private remoteCwd(profile: SshWorkspaceProfile, cwd: string): string {
    const relativePath = relative(resolve(profile.cachePath), resolve(cwd)).replaceAll('\\', '/')
    if (relativePath === '' || relativePath === '.') return profile.remotePath
    if (relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath)) {
      throw new SshWorkspaceValidationError('本地缓存路径不在远程工作区范围内')
    }
    return posix.join(profile.remotePath, relativePath)
  }

  private async credentialForInput(
    input: ReturnType<typeof normalizeProfileInput>,
    existing: SshWorkspaceProfile | undefined,
  ): Promise<SshCredentialPayload | undefined> {
    if (input.authMode === 'agent' || input.authMode === 'openssh-config') return undefined
    const previous = existing === undefined ? undefined : await this.credentials.read(existing.id)
    if (input.authMode === 'password') {
      const password = input.password ?? previous?.password
      if (password === undefined) throw new SshWorkspaceValidationError('请填写 SSH 密码')
      return { version: 1, password }
    }
    const privateKey = input.privateKey ?? previous?.privateKey
    if (privateKey === undefined) throw new SshWorkspaceValidationError('请填写 SSH 私钥')
    const passphrase = input.passphrase ?? previous?.passphrase
    return {
      version: 1,
      privateKey,
      ...(passphrase === undefined ? {} : { passphrase }),
    }
  }

  private cancelTerminalClose(key: string): void {
    const timer = this.terminalCloses.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.terminalCloses.delete(key)
    }
  }
}

export type SshWorkspaceService = Pick<SshWorkspaceManager,
  | 'findByCachePath'
  | 'findDirectByCachePath'
  | 'executeForCachePath'
  | 'listRemoteDirectory'
  | 'searchRemoteFiles'
  | 'statRemoteFile'
  | 'readRemoteFile'
  | 'readRemoteRange'
  | 'writeRemoteFile'
  | 'createRemoteDirectory'
  | 'removeRemotePath'
  | 'renameRemotePath'
  | 'remoteChangesForCachePath'
  | 'openTerminal'
  | 'scheduleTerminalClose'
  | 'closeTerminal'
>
