import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'
import {
  closeSftp,
  connectionSpec,
  openSftp,
  openSshConnection,
  sftpDownloadFileAtomic,
  sftpHashFile,
  sftpMkdirp,
  sftpReadDir,
  sftpRealpath,
  sftpStat,
  sftpUnlink,
  sftpWriteFileFromPathAtomic,
  type RemoteFileEntry,
  type RemoteFileStat,
  type StreamedFileResult,
  type StreamedRemoteWriteResult,
  type SshConnection,
} from './ssh-client.ts'
import { openRemoteHelperSession, parseJsonLines, type RemoteHelperSession } from './remote-helper.ts'
import type { SshCredentialPayload, SshWorkspaceProfile } from './types.ts'
import { safeRelativePath } from './validation.ts'

const MANIFEST_VERSION = 1
const GIBIBYTE = 1024 * 1024 * 1024
export const SSH_SYNC_LIMITS = Object.freeze({
  maxEntries: 50_000,
  maxTotalBytes: 100 * GIBIBYTE,
  maxFileBytes: 6 * GIBIBYTE,
})
const { maxEntries: MAX_ENTRIES, maxTotalBytes: MAX_TOTAL_BYTES, maxFileBytes: MAX_FILE_BYTES } = SSH_SYNC_LIMITS
const CONFLICT_DIRECTORY = '.dsh-conflicts'
const SYNC_TEMP_PREFIX = '.dsh-sync-'

export interface SyncManifestEntry {
  readonly remoteRevision: string
  readonly remoteHash: string
  readonly localHash: string
  readonly localRevision?: string
  readonly size: number
}

export interface SyncConflict {
  readonly path: string
  readonly localHash?: string
  readonly remoteHash?: string
  readonly remoteDeleted: boolean
  readonly copyPath?: string
  readonly detectedAt: string
}

export interface SyncManifest {
  readonly version: typeof MANIFEST_VERSION
  readonly profileId: string
  readonly remoteRoot: string
  readonly entries: Record<string, SyncManifestEntry>
  readonly conflicts: Record<string, SyncConflict>
  readonly updatedAt: string
}

export interface SyncReport {
  readonly remoteRoot: string
  readonly filesPulled: number
  readonly filesPushed: number
  readonly filesDeletedLocally: number
  readonly filesDeletedRemotely: number
  readonly conflicts: readonly SyncConflict[]
  readonly scannedFiles: number
  readonly completedAt: string
}

export interface ReconcileWorkspaceOptions {
  readonly allowBulkDelete?: boolean
  readonly hashLocal?: (entry: LocalEntry) => Promise<string>
}

export const SSH_SYNC_DELETE_GUARD = Object.freeze({
  minimumCandidates: 100,
  minimumRatio: 0.25,
})

export class SshBulkDeletionError extends Error {
  readonly code = 'BULK_DELETE_CONFIRMATION_REQUIRED'

  constructor(
    readonly candidateCount: number,
    readonly trackedCount: number,
  ) {
    super(`检测到 ${candidateCount} 个文件可能被批量删除；请确认后再继续同步`)
  }
}

export interface LocalEntry {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

interface RemoteTree {
  readonly files: Map<string, RemoteFileEntry>
  readonly directories: Set<string>
  readonly totalBytes: number
}

export function assertSshSyncFileSize(size: number, path: string): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid file size for SSH workspace: ${path}`)
  if (size > MAX_FILE_BYTES) throw new Error(`File exceeds the 6GB SSH workspace limit: ${path}`)
}

export function assertSshSyncTotalSize(size: number, location: 'local' | 'remote'): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid ${location} SSH workspace size`)
  if (size > MAX_TOTAL_BYTES) throw new Error(`${location} SSH workspace exceeds the 100GB sync limit`)
}

export interface SyncRemote {
  readonly root: string
  scan(excludes: ReadonlySet<string>): Promise<RemoteTree>
  stat(relativePath: string): Promise<RemoteFileStat | undefined>
  hash(relativePath: string): Promise<StreamedFileResult>
  download(relativePath: string, localPath: string): Promise<StreamedFileResult>
  upload(relativePath: string, localPath: string): Promise<StreamedRemoteWriteResult>
  mkdir(relativePath: string): Promise<void>
  unlink(relativePath: string): Promise<void>
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function localPath(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath)
  const candidate = resolve(root, ...safe.split('/'))
  if (!inside(resolve(root), candidate)) throw new Error(`缓存路径越界：${relativePath}`)
  return candidate
}

function isExcluded(relativePath: string, excludes: ReadonlySet<string>): boolean {
  const segments = relativePath.split('/').filter(Boolean)
  return segments.some(segment => excludes.has(segment) || segment.startsWith(SYNC_TEMP_PREFIX))
}

function remoteRevision(entry: Pick<RemoteFileEntry | RemoteFileStat, 'mtimeMs' | 'size'>): string {
  return `${Math.trunc(entry.mtimeMs)}:${entry.size}`
}

function localRevision(entry: Pick<LocalEntry, 'mtimeMs' | 'size'>): string {
  return `${entry.mtimeMs}:${entry.size}`
}

async function fileSha256(entry: LocalEntry): Promise<string> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(entry.path)) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    assertSshSyncFileSize(size, entry.path)
    hash.update(value)
  }
  const current = await stat(entry.path)
  if (size !== entry.size || current.size !== entry.size || current.mtimeMs !== entry.mtimeMs) {
    throw new Error(`本地文件在同步过程中发生变化，请重试：${entry.path}`)
  }
  return hash.digest('hex')
}

async function scanLocal(root: string, excludes: ReadonlySet<string>): Promise<{
  files: Map<string, LocalEntry>
  directories: Set<string>
}> {
  await mkdir(root, { recursive: true })
  const files = new Map<string, LocalEntry>()
  const directories = new Set<string>()
  let totalBytes = 0
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }]
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const current = pending[cursor] as { absolute: string; relative: string }
    const directory = await opendir(current.absolute)
    for await (const entry of directory) {
      const rel = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`
      if (isExcluded(rel, excludes)) continue
      const absolute = localPath(root, rel)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        directories.add(rel)
        pending.push({ absolute, relative: rel })
      } else if (entry.isFile()) {
        const info = await stat(absolute)
        assertSshSyncFileSize(info.size, absolute)
        totalBytes += info.size
        assertSshSyncTotalSize(totalBytes, 'local')
        files.set(rel, { path: absolute, size: info.size, mtimeMs: info.mtimeMs })
        if (files.size > MAX_ENTRIES) throw new Error(`本地缓存文件数超过 ${MAX_ENTRIES} 个同步限制`)
      }
    }
  }
  return { files, directories }
}

function emptyManifest(profileId: string, remoteRoot: string): SyncManifest {
  return {
    version: MANIFEST_VERSION,
    profileId,
    remoteRoot,
    entries: {},
    conflicts: {},
    updatedAt: new Date(0).toISOString(),
  }
}

function parseManifest(value: unknown, profileId: string, remoteRoot: string): SyncManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyManifest(profileId, remoteRoot)
  const doc = value as Record<string, unknown>
  if (doc.version !== MANIFEST_VERSION || doc.profileId !== profileId || doc.remoteRoot !== remoteRoot) {
    return emptyManifest(profileId, remoteRoot)
  }
  const entries: Record<string, SyncManifestEntry> = {}
  if (doc.entries !== null && typeof doc.entries === 'object' && !Array.isArray(doc.entries)) {
    for (const [path, raw] of Object.entries(doc.entries as Record<string, unknown>)) {
      try { safeRelativePath(path) } catch { continue }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const entry = raw as Record<string, unknown>
      if (typeof entry.remoteRevision !== 'string' || typeof entry.remoteHash !== 'string'
        || typeof entry.localHash !== 'string' || typeof entry.size !== 'number') continue
      entries[path] = {
        remoteRevision: entry.remoteRevision,
        remoteHash: entry.remoteHash,
        localHash: entry.localHash,
        ...(typeof entry.localRevision === 'string' ? { localRevision: entry.localRevision } : {}),
        size: entry.size,
      }
    }
  }
  const conflicts: Record<string, SyncConflict> = {}
  if (doc.conflicts !== null && typeof doc.conflicts === 'object' && !Array.isArray(doc.conflicts)) {
    for (const [path, raw] of Object.entries(doc.conflicts as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const conflict = raw as Record<string, unknown>
      if (typeof conflict.path !== 'string' || typeof conflict.remoteDeleted !== 'boolean' || typeof conflict.detectedAt !== 'string') continue
      conflicts[path] = {
        path: conflict.path,
        ...(typeof conflict.localHash === 'string' ? { localHash: conflict.localHash } : {}),
        ...(typeof conflict.remoteHash === 'string' ? { remoteHash: conflict.remoteHash } : {}),
        remoteDeleted: conflict.remoteDeleted,
        ...(typeof conflict.copyPath === 'string' ? { copyPath: conflict.copyPath } : {}),
        detectedAt: conflict.detectedAt,
      }
    }
  }
  return { version: MANIFEST_VERSION, profileId, remoteRoot, entries, conflicts, updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date(0).toISOString() }
}

export async function readSyncManifest(path: string, profileId: string, remoteRoot: string): Promise<SyncManifest> {
  try {
    return parseManifest(JSON.parse(await readFile(path, 'utf8')) as unknown, profileId, remoteRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return emptyManifest(profileId, remoteRoot)
    throw error
  }
}

export async function writeSyncManifest(path: string, manifest: SyncManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.manifest-${process.pid}-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try { await rename(temporary, path) } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function conflictCopy(
  cacheRoot: string,
  relativePath: string,
  remote: SyncRemote | undefined,
  localHash: string | undefined,
  remoteHash: string | undefined,
): Promise<SyncConflict> {
  const detectedAt = new Date().toISOString()
  let copyPath: string | undefined
  if (remote !== undefined) {
    const suffix = detectedAt.replace(/[:.]/gu, '-')
    const targetRelative = `${relativePath}.remote-${suffix}`
    const target = localPath(join(cacheRoot, CONFLICT_DIRECTORY), targetRelative)
    await remote.download(relativePath, target)
    copyPath = relative(cacheRoot, target)
  }
  return {
    path: relativePath,
    ...(localHash === undefined ? {} : { localHash }),
    ...(remoteHash === undefined ? {} : { remoteHash }),
    remoteDeleted: remote === undefined,
    ...(copyPath === undefined ? {} : { copyPath }),
    detectedAt,
  }
}

function sameConflict(left: SyncConflict | undefined, localHash: string | undefined, remoteHash: string | undefined, remoteDeleted: boolean): boolean {
  return left !== undefined
    && left.localHash === localHash
    && left.remoteHash === remoteHash
    && left.remoteDeleted === remoteDeleted
}

/** Reconcile one cache against one already-connected remote filesystem. */
export async function reconcileWorkspace(
  profile: SshWorkspaceProfile,
  manifestPath: string,
  remote: SyncRemote,
  options: ReconcileWorkspaceOptions = {},
): Promise<SyncReport> {
  const excludes = new Set(profile.excludes)
  excludes.add(CONFLICT_DIRECTORY)
  await mkdir(profile.cachePath, { recursive: true })
  const [remoteTree, localTree, previous] = await Promise.all([
    remote.scan(excludes),
    scanLocal(profile.cachePath, excludes),
    readSyncManifest(manifestPath, profile.id, remote.root),
  ])
  for (const directory of [...remoteTree.directories].sort()) await mkdir(localPath(profile.cachePath, directory), { recursive: true })
  for (const directory of [...localTree.directories].sort()) await remote.mkdir(directory)

  const entries: Record<string, SyncManifestEntry> = { ...previous.entries }
  const conflicts: Record<string, SyncConflict> = { ...previous.conflicts }
  const paths = new Set([...Object.keys(previous.entries), ...remoteTree.files.keys(), ...localTree.files.keys()])
  const deletionCandidates = Object.keys(previous.entries).filter((path) => (
    remoteTree.files.has(path) !== localTree.files.has(path)
  )).length
  if (options.allowBulkDelete !== true
    && deletionCandidates >= SSH_SYNC_DELETE_GUARD.minimumCandidates
    && deletionCandidates / Math.max(1, Object.keys(previous.entries).length) >= SSH_SYNC_DELETE_GUARD.minimumRatio) {
    throw new SshBulkDeletionError(deletionCandidates, Object.keys(previous.entries).length)
  }
  let filesPulled = 0
  let filesPushed = 0
  let filesDeletedLocally = 0
  let filesDeletedRemotely = 0

  for (const relativePath of [...paths].sort()) {
    const remoteEntry = remoteTree.files.get(relativePath)
    const localEntry = localTree.files.get(relativePath)
    const baseline = previous.entries[relativePath]
    let localHash: string | undefined
    const readLocalHash = async (): Promise<string | undefined> => {
      if (localEntry === undefined) return undefined
      if (localHash === undefined) {
        localHash = baseline?.localRevision === localRevision(localEntry)
          ? baseline.localHash
          : await (options.hashLocal ?? fileSha256)(localEntry)
      }
      return localHash
    }
    let remoteHash: string | undefined
    const readRemoteHash = async (): Promise<string> => {
      remoteHash ??= (await remote.hash(relativePath)).hash
      return remoteHash
    }
    const downloadRemote = async (target: string): Promise<StreamedFileResult & { localRevision: string }> => {
      const result = await remote.download(relativePath, target)
      remoteHash = result.hash
      const current = await stat(target)
      return { ...result, localRevision: localRevision({ size: current.size, mtimeMs: current.mtimeMs }) }
    }

    if (baseline === undefined) {
      if (remoteEntry !== undefined && localEntry !== undefined) {
        const [localDigest, remoteDigest] = await Promise.all([readLocalHash(), readRemoteHash()])
        if (localDigest === remoteDigest) {
          entries[relativePath] = { remoteRevision: remoteRevision(remoteEntry), remoteHash: remoteDigest, localHash: remoteDigest, localRevision: localRevision(localEntry), size: remoteEntry.size }
          delete conflicts[relativePath]
        } else if (!sameConflict(conflicts[relativePath], localDigest, remoteDigest, false)) {
          conflicts[relativePath] = await conflictCopy(profile.cachePath, relativePath, remote, localDigest, remoteDigest)
        }
      } else if (remoteEntry !== undefined) {
        const value = await downloadRemote(localPath(profile.cachePath, relativePath))
        entries[relativePath] = { remoteRevision: remoteRevision(remoteEntry), remoteHash: value.hash, localHash: value.hash, localRevision: value.localRevision, size: value.size }
        delete conflicts[relativePath]
        filesPulled++
      } else if (localEntry !== undefined) {
        const written = await remote.upload(relativePath, localEntry.path)
        entries[relativePath] = { remoteRevision: remoteRevision(written.stat), remoteHash: written.hash, localHash: written.hash, localRevision: localRevision(localEntry), size: written.size }
        delete conflicts[relativePath]
        filesPushed++
      }
      continue
    }

    if (remoteEntry === undefined && localEntry === undefined) {
      delete entries[relativePath]
      delete conflicts[relativePath]
      continue
    }

    if (remoteEntry === undefined && localEntry !== undefined) {
      const digest = await readLocalHash() as string
      if (digest === baseline.localHash) {
        await rm(localEntry.path, { force: true })
        delete entries[relativePath]
        delete conflicts[relativePath]
        filesDeletedLocally++
      } else if (!sameConflict(conflicts[relativePath], digest, undefined, true)) {
        conflicts[relativePath] = await conflictCopy(profile.cachePath, relativePath, undefined, digest, undefined)
      }
      continue
    }

    if (remoteEntry !== undefined && localEntry === undefined) {
      const revisionChanged = remoteRevision(remoteEntry) !== baseline.remoteRevision
      let changed = revisionChanged
      if (revisionChanged) changed = await readRemoteHash() !== baseline.remoteHash
      if (!changed) {
        await remote.unlink(relativePath)
        delete entries[relativePath]
        delete conflicts[relativePath]
        filesDeletedRemotely++
      } else {
        const value = await downloadRemote(localPath(profile.cachePath, relativePath))
        entries[relativePath] = { remoteRevision: remoteRevision(remoteEntry), remoteHash: value.hash, localHash: value.hash, localRevision: value.localRevision, size: value.size }
        delete conflicts[relativePath]
        filesPulled++
      }
      continue
    }

    const existingRemote = remoteEntry as RemoteFileEntry
    const existingLocal = localEntry as LocalEntry
    const digest = await readLocalHash() as string
    const localChanged = digest !== baseline.localHash
    let remoteChanged = remoteRevision(existingRemote) !== baseline.remoteRevision
    if (remoteChanged) remoteChanged = await readRemoteHash() !== baseline.remoteHash
    if (!localChanged && !remoteChanged) {
      const nextLocalRevision = localRevision(existingLocal)
      if (remoteRevision(existingRemote) !== baseline.remoteRevision || nextLocalRevision !== baseline.localRevision) {
        entries[relativePath] = { ...baseline, remoteRevision: remoteRevision(existingRemote), localRevision: nextLocalRevision }
      }
      continue
    }
    if (localChanged && remoteChanged) {
      const remoteDigest = await readRemoteHash()
      if (digest === remoteDigest) {
        entries[relativePath] = { remoteRevision: remoteRevision(existingRemote), remoteHash: remoteDigest, localHash: digest, localRevision: localRevision(existingLocal), size: existingRemote.size }
        delete conflicts[relativePath]
      } else if (!sameConflict(conflicts[relativePath], digest, remoteDigest, false)) {
        conflicts[relativePath] = await conflictCopy(profile.cachePath, relativePath, remote, digest, remoteDigest)
      }
    } else if (remoteChanged) {
      const value = await downloadRemote(existingLocal.path)
      entries[relativePath] = { remoteRevision: remoteRevision(existingRemote), remoteHash: value.hash, localHash: value.hash, localRevision: value.localRevision, size: value.size }
      delete conflicts[relativePath]
      filesPulled++
    } else {
      const written = await remote.upload(relativePath, existingLocal.path)
      entries[relativePath] = { remoteRevision: remoteRevision(written.stat), remoteHash: digest, localHash: digest, localRevision: localRevision(existingLocal), size: written.size }
      delete conflicts[relativePath]
      filesPushed++
    }
  }

  const completedAt = new Date().toISOString()
  await writeSyncManifest(manifestPath, {
    version: MANIFEST_VERSION,
    profileId: profile.id,
    remoteRoot: remote.root,
    entries,
    conflicts,
    updatedAt: completedAt,
  })
  return {
    remoteRoot: remote.root,
    filesPulled,
    filesPushed,
    filesDeletedLocally,
    filesDeletedRemotely,
    conflicts: Object.values(conflicts),
    scannedFiles: paths.size,
    completedAt,
  }
}

class SftpSyncRemote implements SyncRemote {
  constructor(readonly root: string, private readonly sftp: SFTPWrapper) {}

  private path(relativePath: string): string {
    return posix.join(this.root, safeRelativePath(relativePath))
  }

  async scan(excludes: ReadonlySet<string>): Promise<RemoteTree> {
    const files = new Map<string, RemoteFileEntry>()
    const directories = new Set<string>()
    const pending = ['']
    let totalBytes = 0
    let entries = 0
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const directory = pending[cursor] as string
      const absolute = directory === '' ? this.root : this.path(directory)
      for (const entry of await sftpReadDir(this.sftp, absolute)) {
        const name = posix.basename(entry.path)
        if (name === '.' || name === '..') continue
        const relativePath = directory === '' ? name : `${directory}/${name}`
        safeRelativePath(relativePath)
        if (isExcluded(relativePath, excludes)) continue
        entries++
        if (entries > MAX_ENTRIES) throw new Error(`远程目录条目数超过 ${MAX_ENTRIES} 个同步限制`)
        if (entry.kind === 'directory') {
          directories.add(relativePath)
          pending.push(relativePath)
        } else if (entry.kind === 'file') {
          assertSshSyncFileSize(entry.size, entry.path)
          totalBytes += entry.size
          assertSshSyncTotalSize(totalBytes, 'remote')
          files.set(relativePath, entry)
        }
      }
    }
    return { files, directories, totalBytes }
  }

  async stat(relativePath: string): Promise<RemoteFileStat | undefined> {
    return await sftpStat(this.sftp, this.path(relativePath))
  }

  async hash(relativePath: string): Promise<StreamedFileResult> {
    return await sftpHashFile(this.sftp, this.path(relativePath), MAX_FILE_BYTES)
  }

  async download(relativePath: string, localPath: string): Promise<StreamedFileResult> {
    return await sftpDownloadFileAtomic(this.sftp, this.path(relativePath), localPath, MAX_FILE_BYTES)
  }

  async upload(relativePath: string, localPath: string): Promise<StreamedRemoteWriteResult> {
    return await sftpWriteFileFromPathAtomic(this.sftp, this.path(relativePath), localPath, MAX_FILE_BYTES)
  }

  async mkdir(relativePath: string): Promise<void> {
    await sftpMkdirp(this.sftp, this.path(relativePath))
  }

  async unlink(relativePath: string): Promise<void> {
    await sftpUnlink(this.sftp, this.path(relativePath))
  }
}

interface HelperTreeEntry extends RemoteFileStat { readonly path: string }

function remoteKind(value: unknown): RemoteFileStat['kind'] {
  if (value === 'file' || value === 'directory' || value === 'symlink' || value === 'other') return value
  throw new Error('远端助手返回了无效的文件类型')
}

function helperStat(value: unknown): RemoteFileStat | undefined {
  if (value === null) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('远端助手返回了无效的文件状态')
  const row = value as Record<string, unknown>
  const size = Number(row.size)
  const mtimeMs = Number(row.mtimeMs)
  const mode = Number(row.mode)
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mtimeMs) || !Number.isSafeInteger(mode)) {
    throw new Error('远端助手返回了无效的文件元数据')
  }
  return { kind: remoteKind(row.kind), size, mtimeMs, mode }
}

function helperJson<T>(value: Buffer): T {
  const text = value.toString('utf8').trim()
  if (text === '') throw new Error('远端助手没有返回预期的 JSON')
  return JSON.parse(text) as T
}

function helperError(stderr: Buffer): string {
  return stderr.toString('utf8').replace(/[\r\n]+/gu, ' ').trim().slice(0, 1_000)
}

function helperHashingTransform(limit: number, source: string): {
  readonly stream: Transform
  readonly result: () => StreamedFileResult
} {
  const digest = createHash('sha256')
  let size = 0
  const stream = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += data.length
      if (size > limit) {
        callback(new Error(`文件超过 SSH 工作区单文件限制：${source}`))
        return
      }
      digest.update(data)
      callback(null, data)
    },
  })
  return { stream, result: () => ({ hash: digest.digest('hex'), size }) }
}

async function collectProcessOutput(
  source: NodeJS.ReadableStream,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of source) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += data.length
    if (total > limit) throw new Error('远端助手输出超过限制')
    chunks.push(data)
  }
  return Buffer.concat(chunks)
}

/** Remote filesystem provider backed by the versioned helper over system OpenSSH. */
class HelperSyncRemote implements SyncRemote {
  constructor(readonly root: string, private readonly helper: RemoteHelperSession) {}

  private path(relativePath: string): string {
    return posix.join(this.root, safeRelativePath(relativePath))
  }

  async scan(excludes: ReadonlySet<string>): Promise<RemoteTree> {
    const encoded = Buffer.from(JSON.stringify([...excludes]), 'utf8').toString('base64url')
    const result = await this.helper.exec(['scan', this.root, encoded], { outputLimit: 32 * 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(helperError(result.stderr) || '远端目录扫描失败')
    const files = new Map<string, RemoteFileEntry>()
    const directories = new Set<string>()
    let totalBytes = 0
    let entries = 0
    for (const value of parseJsonLines<HelperTreeEntry>(result.stdout)) {
      const relativePath = safeRelativePath(value.path)
      const info = helperStat(value)
      if (info === undefined) continue
      entries++
      if (entries > MAX_ENTRIES) throw new Error(`远端目录条目数超过 ${MAX_ENTRIES} 个同步限制`)
      if (info.kind === 'directory') directories.add(relativePath)
      else if (info.kind === 'file') {
        assertSshSyncFileSize(info.size, relativePath)
        totalBytes += info.size
        assertSshSyncTotalSize(totalBytes, 'remote')
        files.set(relativePath, { path: posix.join(this.root, relativePath), ...info })
      }
    }
    return { files, directories, totalBytes }
  }

  async stat(relativePath: string): Promise<RemoteFileStat | undefined> {
    const result = await this.helper.exec(['stat', this.path(relativePath)])
    if (result.exitCode !== 0) throw new Error(helperError(result.stderr) || '读取远端文件状态失败')
    const body = helperJson<{ readonly stat: unknown }>(result.stdout)
    return helperStat(body.stat)
  }

  async hash(relativePath: string): Promise<StreamedFileResult> {
    const result = await this.helper.exec(['hash', this.path(relativePath)])
    if (result.exitCode !== 0) throw new Error(helperError(result.stderr) || '计算远端文件校验值失败')
    const body = helperJson<{ readonly hash: unknown; readonly size: unknown }>(result.stdout)
    if (typeof body.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(body.hash) || !Number.isSafeInteger(body.size)) {
      throw new Error('远端助手返回了无效的文件校验值')
    }
    assertSshSyncFileSize(body.size as number, relativePath)
    return { hash: body.hash, size: body.size as number }
  }

  async download(relativePath: string, destination: string): Promise<StreamedFileResult> {
    const before = await this.stat(relativePath)
    if (before?.kind !== 'file') throw new Error(`远端文件不存在：${relativePath}`)
    assertSshSyncFileSize(before.size, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.dsh-download-${process.pid}-${randomUUID()}`
    const remoteProcess = await this.helper.spawn(['read', this.path(relativePath)])
    const hashing = helperHashingTransform(MAX_FILE_BYTES, relativePath)
    const stderr = collectProcessOutput(remoteProcess.stderr, 1_024 * 1_024)
    const finished = remoteProcess.wait()
    try {
      await pipeline(remoteProcess.stdout, hashing.stream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
      const completion = await finished
      const error = await stderr
      if (completion.exitCode !== 0) throw new Error(helperError(error) || '下载远端文件失败')
      const result = hashing.result()
      const after = await this.stat(relativePath)
      if (after?.kind !== 'file' || after.size !== before.size || after.mtimeMs !== before.mtimeMs || result.size !== before.size) {
        throw new Error(`远端文件在下载过程中发生变化：${relativePath}`)
      }
      const handle = await open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      await rename(temporary, destination)
      return result
    } catch (error) {
      remoteProcess.close()
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async upload(relativePath: string, source: string): Promise<StreamedRemoteWriteResult> {
    const before = await stat(source)
    if (!before.isFile()) throw new Error(`本地文件不存在：${source}`)
    assertSshSyncFileSize(before.size, source)
    const remoteProcess = await this.helper.spawn(['write', this.path(relativePath), String(MAX_FILE_BYTES)])
    const stdout = collectProcessOutput(remoteProcess.stdout, 1_024 * 1_024)
    const stderr = collectProcessOutput(remoteProcess.stderr, 1_024 * 1_024)
    const finished = remoteProcess.wait()
    const hashing = helperHashingTransform(MAX_FILE_BYTES, source)
    try {
      await pipeline(createReadStream(source), hashing.stream, remoteProcess.stdin)
      const completion = await finished
      const error = await stderr
      if (completion.exitCode !== 0) throw new Error(helperError(error) || '上传远端文件失败')
      const local = hashing.result()
      const current = await stat(source)
      if (current.size !== before.size || current.mtimeMs !== before.mtimeMs || local.size !== before.size) {
        throw new Error(`本地文件在上传过程中发生变化：${source}`)
      }
      const body = helperJson<{ readonly hash: unknown; readonly size: unknown; readonly stat: unknown }>(await stdout)
      const remote = helperStat(body.stat)
      if (typeof body.hash !== 'string' || body.hash !== local.hash || body.size !== local.size || remote?.kind !== 'file' || remote.size !== local.size) {
        throw new Error(`远端文件写入校验失败：${relativePath}`)
      }
      return { hash: local.hash, size: local.size, stat: remote }
    } catch (error) {
      remoteProcess.close()
      throw error
    }
  }

  async mkdir(relativePath: string): Promise<void> {
    const result = await this.helper.exec(['mkdir', this.path(relativePath)])
    if (result.exitCode !== 0) throw new Error(helperError(result.stderr) || '创建远端目录失败')
  }

  async unlink(relativePath: string): Promise<void> {
    const result = await this.helper.exec(['unlink', this.path(relativePath)])
    if (result.exitCode !== 0) throw new Error(helperError(result.stderr) || '删除远端文件失败')
  }
}

/** Open a verified connection, run a complete reconciliation, and close it. */
export async function syncSshWorkspace(
  profile: SshWorkspaceProfile,
  credential: SshCredentialPayload | undefined,
  manifestPath: string,
  options: Pick<ReconcileWorkspaceOptions, 'allowBulkDelete'> = {},
  pooledConnection?: SshConnection,
): Promise<SyncReport> {
  if (profile.transportMode === 'system' || profile.authMode === 'openssh-config' || profile.openSshHost !== undefined) {
    const helper = await openRemoteHelperSession(profile, credential)
    try {
      const resolved = await helper.exec(['realpath', profile.remotePath])
      if (resolved.exitCode !== 0) throw new Error(helperError(resolved.stderr) || '远程工作区目录不可用')
      const remoteRoot = helperJson<{ readonly path: string }>(resolved.stdout).path
      if (typeof remoteRoot !== 'string' || !posix.isAbsolute(remoteRoot)) throw new Error('远端助手返回了无效的工作区路径')
      return await reconcileWorkspace(profile, manifestPath, new HelperSyncRemote(remoteRoot, helper), options)
    } finally {
      helper.dispose()
    }
  }
  const connection = pooledConnection ?? await openSshConnection(connectionSpec(profile, credential))
  let sftp: SFTPWrapper | undefined
  try {
    sftp = await openSftp(connection.client)
    const remoteRoot = await sftpRealpath(sftp, profile.remotePath)
    const rootInfo = await sftpStat(sftp, remoteRoot)
    if (rootInfo?.kind !== 'directory') throw new Error(`远程工作区不是目录：${profile.remotePath}`)
    return await reconcileWorkspace(profile, manifestPath, new SftpSyncRemote(remoteRoot, sftp), options)
  } finally {
    if (sftp !== undefined) closeSftp(sftp)
    if (pooledConnection === undefined) connection.dispose()
  }
}

export type ConflictResolution = 'local' | 'remote'

/** Resolve one recorded conflict explicitly; no side wins without this user decision. */
export async function resolveSshConflict(
  profile: SshWorkspaceProfile,
  credential: SshCredentialPayload | undefined,
  manifestPath: string,
  relativePathInput: string,
  strategy: ConflictResolution,
  pooledConnection?: SshConnection,
): Promise<SyncManifest> {
  const relativePath = safeRelativePath(relativePathInput)
  if (profile.transportMode === 'system' || profile.authMode === 'openssh-config' || profile.openSshHost !== undefined) {
    const helper = await openRemoteHelperSession(profile, credential)
    try {
      const resolvedRoot = await helper.exec(['realpath', profile.remotePath])
      if (resolvedRoot.exitCode !== 0) throw new Error(helperError(resolvedRoot.stderr) || '远程工作区目录不可用')
      const remoteRoot = helperJson<{ readonly path: string }>(resolvedRoot.stdout).path
      const manifest = await readSyncManifest(manifestPath, profile.id, remoteRoot)
      if (manifest.conflicts[relativePath] === undefined) throw new Error(`没有找到待解决的冲突：${relativePath}`)
      const remote = new HelperSyncRemote(remoteRoot, helper)
      const entries = { ...manifest.entries }
      const conflicts = { ...manifest.conflicts }
      if (strategy === 'local') {
        const source = localPath(profile.cachePath, relativePath)
        const written = await remote.upload(relativePath, source)
        const localInfo = await stat(source)
        entries[relativePath] = {
          remoteRevision: remoteRevision(written.stat),
          remoteHash: written.hash,
          localHash: written.hash,
          localRevision: localRevision({ size: localInfo.size, mtimeMs: localInfo.mtimeMs }),
          size: written.size,
        }
      } else {
        const remoteInfo = await remote.stat(relativePath)
        if (remoteInfo === undefined) {
          await rm(localPath(profile.cachePath, relativePath), { force: true })
          delete entries[relativePath]
        } else if (remoteInfo.kind === 'file') {
          const target = localPath(profile.cachePath, relativePath)
          const downloaded = await remote.download(relativePath, target)
          const localInfo = await stat(target)
          entries[relativePath] = {
            remoteRevision: remoteRevision(remoteInfo),
            remoteHash: downloaded.hash,
            localHash: downloaded.hash,
            localRevision: localRevision({ size: localInfo.size, mtimeMs: localInfo.mtimeMs }),
            size: downloaded.size,
          }
        } else {
          throw new Error(`服务器冲突路径不再是文件：${relativePath}`)
        }
      }
      delete conflicts[relativePath]
      const result: SyncManifest = { ...manifest, entries, conflicts, updatedAt: new Date().toISOString() }
      await writeSyncManifest(manifestPath, result)
      return result
    } finally {
      helper.dispose()
    }
  }
  const connection = pooledConnection ?? await openSshConnection(connectionSpec(profile, credential))
  let sftp: SFTPWrapper | undefined
  try {
    sftp = await openSftp(connection.client)
    const remoteRoot = await sftpRealpath(sftp, profile.remotePath)
    const manifest = await readSyncManifest(manifestPath, profile.id, remoteRoot)
    if (manifest.conflicts[relativePath] === undefined) throw new Error(`没有找到待解决的冲突：${relativePath}`)
    const remote = new SftpSyncRemote(remoteRoot, sftp)
    const entries = { ...manifest.entries }
    const conflicts = { ...manifest.conflicts }
    if (strategy === 'local') {
      const source = localPath(profile.cachePath, relativePath)
      const written = await remote.upload(relativePath, source)
      const localInfo = await stat(source)
      entries[relativePath] = {
        remoteRevision: remoteRevision(written.stat),
        remoteHash: written.hash,
        localHash: written.hash,
        localRevision: localRevision({ size: localInfo.size, mtimeMs: localInfo.mtimeMs }),
        size: written.size,
      }
    } else {
      const remoteInfo = await remote.stat(relativePath)
      if (remoteInfo === undefined) {
        await rm(localPath(profile.cachePath, relativePath), { force: true })
        delete entries[relativePath]
      } else if (remoteInfo.kind === 'file') {
        const target = localPath(profile.cachePath, relativePath)
        const downloaded = await remote.download(relativePath, target)
        const localInfo = await stat(target)
        entries[relativePath] = {
          remoteRevision: remoteRevision(remoteInfo),
          remoteHash: downloaded.hash,
          localHash: downloaded.hash,
          localRevision: localRevision({ size: localInfo.size, mtimeMs: localInfo.mtimeMs }),
          size: downloaded.size,
        }
      } else {
        throw new Error(`服务器冲突路径不再是文件：${relativePath}`)
      }
    }
    delete conflicts[relativePath]
    const resolved: SyncManifest = {
      ...manifest,
      entries,
      conflicts,
      updatedAt: new Date().toISOString(),
    }
    await writeSyncManifest(manifestPath, resolved)
    return resolved
  } finally {
    if (sftp !== undefined) closeSftp(sftp)
    if (pooledConnection === undefined) connection.dispose()
  }
}
