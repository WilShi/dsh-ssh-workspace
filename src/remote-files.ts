import { createHash } from 'node:crypto'
import { basename, join, posix, relative, resolve, sep } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import {
  sftpHashFile,
  sftpMkdirp,
  sftpReadDir,
  sftpRealpath,
  sftpStat,
  sftpWriteFileAtomic,
  type RemoteFileStat,
} from './ssh-client.ts'
import { parseJsonLines, type RemoteHelperSession } from './remote-helper.ts'
import type {
  SshRemoteFileEntry,
  SshRemoteFileRange,
  SshRemoteFileRead,
  SshRemoteFileRevision,
  SshRemoteFileStat,
  SshWorkspaceProfile,
} from './types.ts'
import { SshWorkspaceValidationError } from './validation.ts'

interface HelperFileInfo {
  readonly name?: unknown
  readonly path?: unknown
  readonly kind?: unknown
  readonly size?: unknown
  readonly mtimeMs?: unknown
  readonly mode?: unknown
}

function contained(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`))
}

function remoteContained(root: string, candidate: string): boolean {
  const value = posix.relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith('../') && !posix.isAbsolute(value))
}

function parseInfo(value: HelperFileInfo | RemoteFileStat | undefined): RemoteFileStat | undefined {
  if (value === undefined || value === null) return undefined
  if (value.kind !== 'file' && value.kind !== 'directory' && value.kind !== 'symlink' && value.kind !== 'other') return undefined
  const size = Number(value.size)
  const mtimeMs = Number(value.mtimeMs)
  const mode = Number(value.mode)
  if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtimeMs) || !Number.isFinite(mode)) return undefined
  return { kind: value.kind, size, mtimeMs, mode }
}

function stampOf(info: RemoteFileStat): string {
  return `remote:${info.kind}:${String(info.size)}:${String(info.mtimeMs)}:${String(info.mode)}`
}

function revisionOf(info: RemoteFileStat, bytes?: Uint8Array): SshRemoteFileRevision {
  const stamp = stampOf(info)
  return {
    token: bytes === undefined ? `stat:${stamp}` : `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    stamp,
    size: info.size,
    mtimeMs: info.mtimeMs,
    strong: bytes !== undefined,
  }
}

async function helperJson<T>(
  session: RemoteHelperSession,
  args: readonly string[],
  options: { readonly input?: Buffer | string; readonly outputLimit?: number; readonly signal?: AbortSignal } = {},
): Promise<T> {
  const result = await session.exec(args, options)
  if (result.exitCode !== 0) {
    throw new SshWorkspaceValidationError(result.stderr.toString('utf8').trim() || `远程文件操作失败（退出码 ${String(result.exitCode)}）`)
  }
  try { return JSON.parse(result.stdout.toString('utf8').trim()) as T } catch { throw new SshWorkspaceValidationError('远端助手返回了无效结果') }
}

async function sftpReadRange(
  sftp: SFTPWrapper,
  path: string,
  start: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0)
  if (signal?.aborted === true) throw signal.reason ?? new Error('remote read aborted')
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const stream = sftp.createReadStream(path, { start, end: start + length - 1 })
    const cleanup = (): void => { signal?.removeEventListener('abort', onAbort) }
    const onAbort = (): void => {
      const reason = signal?.reason instanceof Error ? signal.reason : new Error('remote read aborted')
      stream.destroy(reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += value.length
      chunks.push(value)
    })
    stream.once('error', (error: Error) => { cleanup(); reject(error) })
    stream.once('end', () => { cleanup(); resolvePromise(Buffer.concat(chunks, size)) })
  })
}

/** Direct, on-demand file access for one SSH workspace. Nothing here mirrors a directory locally. */
export class DirectRemoteFiles {
  constructor(
    readonly profile: SshWorkspaceProfile,
    private readonly session: RemoteHelperSession,
  ) {}

  virtualToRemote(path: string): string {
    const absolute = resolve(path)
    if (!contained(this.profile.cachePath, absolute)) throw new SshWorkspaceValidationError('文件路径不在当前远程工作区内')
    const suffix = relative(resolve(this.profile.cachePath), absolute).replaceAll('\\', '/')
    return suffix === '' ? this.profile.remotePath : posix.join(this.profile.remotePath, suffix)
  }

  remoteToVirtual(path: string): string {
    const suffix = posix.relative(this.profile.remotePath, path)
    if (suffix === '..' || suffix.startsWith('../') || posix.isAbsolute(suffix)) {
      throw new SshWorkspaceValidationError('服务器返回了工作区外的路径')
    }
    return suffix === '' ? this.profile.cachePath : join(this.profile.cachePath, ...suffix.split('/'))
  }

  async list(path: string, maximumEntries: number): Promise<{ path: string; entries: SshRemoteFileEntry[]; truncated: boolean }> {
    const remote = this.virtualToRemote(path)
    await this.assertExistingWithinRoot(remote)
    let rows: Array<{ name: string; info: RemoteFileStat }>
    if (this.session.sftp !== undefined) {
      const listed = await sftpReadDir(this.session.sftp, remote)
      rows = listed.map(item => ({ name: posix.basename(item.path), info: item }))
    } else {
      const result = await this.session.exec(['list', remote, String(maximumEntries)], { outputLimit: 8 * 1024 * 1024 })
      if (result.exitCode !== 0) throw new SshWorkspaceValidationError(result.stderr.toString('utf8').trim() || '无法读取远程目录')
      rows = parseJsonLines<HelperFileInfo>(result.stdout).flatMap((row) => {
        const info = parseInfo(row)
        return typeof row.name === 'string' && info !== undefined ? [{ name: row.name, info }] : []
      })
    }
    const truncated = rows.length > maximumEntries
    return {
      path: resolve(path),
      entries: rows.slice(0, maximumEntries).map(({ name, info }) => ({
        name,
        path: join(resolve(path), name),
        isDir: info.kind === 'directory',
        hidden: name.startsWith('.'),
        isSymlink: info.kind === 'symlink',
        // Direct mode never follows a symlink automatically. It is shown but
        // cannot escape the configured remote root through the file API.
        broken: info.kind === 'symlink',
      })).sort((left, right) => left.isDir === right.isDir
        ? left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
        : left.isDir ? -1 : 1),
      truncated,
    }
  }

  async search(query: string, maximumEntries: number): Promise<{ matches: string[]; truncated: boolean }> {
    const needle = query.trim()
    if (needle === '') return { matches: [], truncated: false }
    if (this.session.helper !== undefined) {
      const exclusions = Buffer.from(JSON.stringify(this.profile.excludes)).toString('base64url')
      const result = await this.session.exec(
        ['search', this.profile.remotePath, needle, String(maximumEntries), exclusions],
        { outputLimit: 8 * 1024 * 1024 },
      )
      if (result.exitCode !== 0) throw new SshWorkspaceValidationError(result.stderr.toString('utf8').trim() || '远程文件搜索失败')
      const rows = parseJsonLines<HelperFileInfo>(result.stdout)
        .flatMap(row => typeof row.path === 'string' ? [row.path] : [])
      return { matches: rows.slice(0, maximumEntries), truncated: rows.length > maximumEntries }
    }
    return await this.searchWithSftp(needle.toLocaleLowerCase(), maximumEntries)
  }

  async stat(path: string): Promise<SshRemoteFileStat> {
    const remote = this.virtualToRemote(path)
    const info = await this.statRemote(remote)
    if (info === undefined) return { exists: false, file: false }
    if (info.kind === 'symlink') return { exists: true, file: false, directory: false, revision: revisionOf(info) }
    await this.assertExistingWithinRoot(remote)
    return {
      exists: true,
      file: info.kind === 'file',
      directory: info.kind === 'directory',
      revision: revisionOf(info),
    }
  }

  async read(path: string, maximumBytes: number, signal?: AbortSignal): Promise<SshRemoteFileRead> {
    const remote = this.virtualToRemote(path)
    const before = await this.regularFile(remote)
    await this.assertExistingWithinRoot(remote)
    const limit = Math.min(before.size, Math.max(0, maximumBytes))
    let bytes: Buffer
    if (this.session.sftp !== undefined) bytes = await sftpReadRange(this.session.sftp, remote, 0, limit, signal)
    else {
      const result = await this.session.exec(['read-head', remote, String(limit)], {
        signal,
        outputLimit: Math.max(64 * 1024, limit + 64 * 1024),
      })
      if (result.exitCode !== 0) throw new SshWorkspaceValidationError(result.stderr.toString('utf8').trim() || '远程文件读取失败')
      bytes = result.stdout
    }
    const after = await this.regularFile(remote)
    if (stampOf(before) !== stampOf(after)) throw new SshWorkspaceValidationError('远程文件在读取过程中发生变化，请重试')
    return { bytes, revision: revisionOf(after, before.size <= maximumBytes ? bytes : undefined), truncated: before.size > maximumBytes }
  }

  /** Read one bounded byte range without downloading or hashing the rest of
   * the remote file. The weak stat revision is enough for media delivery and
   * lets the caller detect a size change between its initial stat and read. */
  async readRange(path: string, start: number, length: number, signal?: AbortSignal): Promise<SshRemoteFileRange> {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new SshWorkspaceValidationError('远程文件读取范围无效')
    }
    const remote = this.virtualToRemote(path)
    const before = await this.regularFile(remote)
    await this.assertExistingWithinRoot(remote)
    const count = start >= before.size ? 0 : Math.min(length, before.size - start)
    let bytes: Buffer
    if (this.session.sftp !== undefined) {
      bytes = await sftpReadRange(this.session.sftp, remote, start, count, signal)
    } else {
      const result = await this.session.exec(['read-range', remote, String(start), String(count)], {
        signal,
        outputLimit: Math.max(64 * 1024, count + 64 * 1024),
      })
      if (result.exitCode !== 0) {
        throw new SshWorkspaceValidationError(result.stderr.toString('utf8').trim() || '远程文件分段读取失败')
      }
      bytes = result.stdout
    }
    const after = await this.regularFile(remote)
    if (stampOf(before) !== stampOf(after) || bytes.byteLength !== count) {
      throw new SshWorkspaceValidationError('远程文件在读取过程中发生变化，请重试')
    }
    return { bytes, revision: revisionOf(after) }
  }

  async write(path: string, bytes: Uint8Array, expectedRevision?: string): Promise<SshRemoteFileRevision> {
    const remote = this.virtualToRemote(path)
    await this.assertWritableWithinRoot(remote)
    if (expectedRevision !== undefined) {
      const current = await this.currentToken(remote, Math.max(bytes.byteLength, 256 * 1024 * 1024))
      if (current !== expectedRevision) throw new SshWorkspaceValidationError('远程文件已被其他程序修改，请重新加载后再保存')
    }
    const content = Buffer.from(bytes)
    let info: RemoteFileStat
    if (this.session.sftp !== undefined) info = await sftpWriteFileAtomic(this.session.sftp, remote, content)
    else {
      const result = await helperJson<{ stat?: HelperFileInfo }>(this.session, ['write', remote, String(content.byteLength)], {
        input: content,
        outputLimit: 1024 * 1024,
      })
      const parsed = parseInfo(result.stat)
      if (parsed === undefined) throw new SshWorkspaceValidationError('远程文件写入后无法确认')
      info = parsed
    }
    return revisionOf(info, content)
  }

  async mkdir(path: string): Promise<void> {
    const remote = this.virtualToRemote(path)
    await this.assertWritableWithinRoot(remote)
    if (this.session.sftp !== undefined) await sftpMkdirp(this.session.sftp, remote)
    else {
      const result = await this.session.exec(['mkdir', remote])
      if (result.exitCode !== 0) throw new SshWorkspaceValidationError(result.stderr.toString('utf8').trim() || '创建远程目录失败')
    }
  }

  async remove(path: string, recursive = false): Promise<void> {
    const remote = this.virtualToRemote(path)
    if (remote === this.profile.remotePath) throw new SshWorkspaceValidationError('不能删除远程工作区根目录')
    await this.assertExistingWithinRoot(remote)
    const result = await this.session.exec(['remove', remote, recursive ? '1' : '0'])
    if (result.exitCode !== 0) throw new SshWorkspaceValidationError(result.stderr.toString('utf8').trim() || '删除远程文件失败')
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.virtualToRemote(from)
    const target = this.virtualToRemote(to)
    if (source === this.profile.remotePath) throw new SshWorkspaceValidationError('不能移动远程工作区根目录')
    await this.assertExistingWithinRoot(source)
    await this.assertWritableWithinRoot(target)
    const result = await this.session.exec(['rename', source, target])
    if (result.exitCode !== 0) throw new SshWorkspaceValidationError(result.stderr.toString('utf8').trim() || '移动远程文件失败')
  }

  private async statRemote(path: string): Promise<RemoteFileStat | undefined> {
    if (this.session.sftp !== undefined) return await sftpStat(this.session.sftp, path)
    const value = await helperJson<{ stat?: HelperFileInfo | null }>(this.session, ['stat', path])
    return parseInfo(value.stat ?? undefined)
  }

  private async regularFile(path: string): Promise<RemoteFileStat> {
    const info = await this.statRemote(path)
    if (info?.kind !== 'file') throw new SshWorkspaceValidationError(`远程文件不存在或不是普通文件：${basename(path)}`)
    return info
  }

  private async currentToken(path: string, maximumBytes: number): Promise<string> {
    const info = await this.statRemote(path)
    if (info === undefined) return 'missing'
    if (info.kind !== 'file') return revisionOf(info).token
    let hash: string
    if (this.session.sftp !== undefined) hash = (await sftpHashFile(this.session.sftp, path, maximumBytes)).hash
    else {
      const value = await helperJson<{ hash?: unknown }>(this.session, ['hash', path], { outputLimit: 1024 * 1024 })
      if (typeof value.hash !== 'string') throw new SshWorkspaceValidationError('无法确认远程文件版本')
      hash = value.hash
    }
    return `sha256:${hash}`
  }

  private async resolvedRemote(path: string): Promise<string> {
    if (this.session.sftp !== undefined) return await sftpRealpath(this.session.sftp, path)
    const value = await helperJson<{ path?: unknown }>(this.session, ['resolve', path])
    if (typeof value.path !== 'string') throw new SshWorkspaceValidationError('无法确认远程文件路径')
    return value.path
  }

  private async assertExistingWithinRoot(path: string): Promise<void> {
    const canonical = await this.resolvedRemote(path)
    if (!remoteContained(this.profile.remotePath, canonical)) throw new SshWorkspaceValidationError('远程路径通过符号链接越出了工作区')
  }

  private async assertWritableWithinRoot(path: string): Promise<void> {
    const existing = await this.statRemote(path)
    const check = existing === undefined ? posix.dirname(path) : path
    const canonical = await this.resolvedRemote(check)
    if (!remoteContained(this.profile.remotePath, canonical)) throw new SshWorkspaceValidationError('远程写入路径越出了工作区')
  }

  private async searchWithSftp(needle: string, maximumEntries: number): Promise<{ matches: string[]; truncated: boolean }> {
    const sftp = this.session.sftp
    if (sftp === undefined) throw new SshWorkspaceValidationError('服务器不支持远程文件搜索')
    const matches: string[] = []
    const queue = [this.profile.remotePath]
    while (queue.length > 0 && matches.length <= maximumEntries) {
      const directory = queue.shift() as string
      for (const row of await sftpReadDir(sftp, directory)) {
        const name = posix.basename(row.path)
        if (this.profile.excludes.includes(name)) continue
        if (name.toLocaleLowerCase().includes(needle)) matches.push(posix.relative(this.profile.remotePath, row.path))
        if (row.kind === 'directory') queue.push(row.path)
        if (matches.length > maximumEntries) break
      }
    }
    return { matches: matches.slice(0, maximumEntries), truncated: matches.length > maximumEntries }
  }
}
