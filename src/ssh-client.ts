import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename as renameLocal, rm, stat } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2'
import type { SshAuthMode, SshCredentialPayload, SshWorkspaceProfile } from './types.ts'

export interface SshConnectionSpec {
  readonly id: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly authMode: SshAuthMode
  readonly hostFingerprint?: string
  readonly credential?: SshCredentialPayload
}

export interface SshConnection {
  readonly client: Client
  readonly fingerprint: string
  readonly serverBanner?: string
  dispose(): void
}

export interface RemoteFileEntry {
  readonly path: string
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly mtimeMs: number
  readonly mode: number
}

export interface RemoteFileStat {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly mtimeMs: number
  readonly mode: number
}

export interface RemoteCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal?: string
}

export interface StreamedFileResult {
  readonly hash: string
  readonly size: number
}

export interface StreamedRemoteWriteResult extends StreamedFileResult {
  readonly stat: RemoteFileStat
}

export class SshConnectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export function sha256Fingerprint(rawKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(rawKey).digest('base64').replace(/=+$/u, '')}`
}

function fingerprintFromVerifierValue(value: Buffer | string): string {
  if (Buffer.isBuffer(value)) return sha256Fingerprint(value)
  const trimmed = value.trim()
  if (/^[a-f0-9]{64}$/iu.test(trimmed)) {
    return `SHA256:${Buffer.from(trimmed, 'hex').toString('base64').replace(/=+$/u, '')}`
  }
  if (trimmed.startsWith('SHA256:')) return trimmed.replace(/=+$/u, '')
  return `SHA256:${Buffer.from(trimmed, 'binary').toString('base64').replace(/=+$/u, '')}`
}

function connectConfig(spec: SshConnectionSpec, verifier: ConnectConfig['hostVerifier']): ConnectConfig {
  const common: ConnectConfig = {
    host: spec.host,
    port: spec.port,
    username: spec.username,
    readyTimeout: 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    hostHash: 'sha256',
    hostVerifier: verifier,
  }
  switch (spec.authMode) {
    case 'password': {
      if (spec.credential?.password === undefined) throw new SshConnectionError('CREDENTIAL_MISSING', '尚未保存 SSH 密码')
      return { ...common, password: spec.credential.password }
    }
    case 'private-key': {
      if (spec.credential?.privateKey === undefined) throw new SshConnectionError('CREDENTIAL_MISSING', '尚未保存 SSH 私钥')
      return {
        ...common,
        privateKey: spec.credential.privateKey,
        ...(spec.credential.passphrase === undefined ? {} : { passphrase: spec.credential.passphrase }),
      }
    }
    case 'agent': {
      const agent = process.env.SSH_AUTH_SOCK
      if (agent === undefined || agent === '') throw new SshConnectionError('SSH_AGENT_UNAVAILABLE', '当前环境没有可用的 SSH Agent')
      return { ...common, agent }
    }
    case 'openssh-config':
      throw new SshConnectionError('SYSTEM_SSH_REQUIRED', 'OpenSSH 配置认证必须使用系统 OpenSSH 引擎')
  }
}

/** Open one verified SSH connection. No credential value is retained after disposal. */
export async function openSshConnection(spec: SshConnectionSpec): Promise<SshConnection> {
  const client = new Client()
  let observedFingerprint = ''
  let mismatch = false
  let banner: string | undefined
  const config = connectConfig(spec, (value: Buffer | string) => {
    observedFingerprint = fingerprintFromVerifierValue(value)
    mismatch = spec.hostFingerprint !== undefined && observedFingerprint !== spec.hostFingerprint.replace(/=+$/u, '')
    return !mismatch
  })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      client.removeListener('ready', onReady)
      client.removeListener('error', onError)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onReady = (): void => finish()
    const onError = (error: Error): void => {
      if (mismatch) {
        finish(new SshConnectionError(
          'HOST_KEY_MISMATCH',
          `服务器主机指纹已变化：期望 ${spec.hostFingerprint ?? '未知'}，实际 ${observedFingerprint || '未知'}`,
        ))
      } else {
        finish(new SshConnectionError('SSH_CONNECT_FAILED', `SSH 连接失败：${error.message}`))
      }
    }
    client.once('ready', onReady)
    client.once('error', onError)
    client.on('banner', (message) => { banner = String(message).trim().slice(0, 512) })
    try {
      client.connect(config)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  }).catch((error) => {
    client.end()
    throw error
  })
  if (observedFingerprint === '') {
    client.end()
    throw new SshConnectionError('HOST_KEY_UNAVAILABLE', '服务器没有提供可验证的主机密钥')
  }
  return {
    client,
    fingerprint: observedFingerprint,
    ...(banner === undefined || banner === '' ? {} : { serverBanner: banner }),
    dispose: () => client.end(),
  }
}

export async function openSftp(client: Client): Promise<SFTPWrapper> {
  return await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error !== undefined) reject(new SshConnectionError('SFTP_UNAVAILABLE', `无法打开 SFTP：${error.message}`))
      else resolve(sftp)
    })
  })
}

export function closeSftp(sftp: SFTPWrapper): void {
  try { sftp.end() } catch { /* connection already closed */ }
}

function fileKind(attrs: Stats): RemoteFileStat['kind'] {
  if (attrs.isFile()) return 'file'
  if (attrs.isDirectory()) return 'directory'
  if (attrs.isSymbolicLink()) return 'symlink'
  return 'other'
}

function statView(attrs: Stats): RemoteFileStat {
  return {
    kind: fileKind(attrs),
    size: Number(attrs.size),
    mtimeMs: Number(attrs.mtime) * 1_000,
    mode: Number(attrs.mode),
  }
}

export async function sftpStat(sftp: SFTPWrapper, path: string): Promise<RemoteFileStat | undefined> {
  return await new Promise<RemoteFileStat | undefined>((resolve, reject) => {
    sftp.lstat(path, (error, attrs) => {
      if (error !== undefined) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || /no such file/iu.test(error.message)) resolve(undefined)
        else reject(error)
        return
      }
      resolve(statView(attrs))
    })
  })
}

export async function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    sftp.realpath(path, (error, absolutePath) => error !== undefined ? reject(error) : resolve(absolutePath))
  })
}

export async function sftpReadDir(sftp: SFTPWrapper, path: string): Promise<RemoteFileEntry[]> {
  return await new Promise<RemoteFileEntry[]>((resolve, reject) => {
    sftp.readdir(path, (error, list) => {
      if (error !== undefined) { reject(error); return }
      resolve(list.map(entry => ({
        path: posix.join(path, entry.filename),
        ...statView(entry.attrs),
      })))
    })
  })
}

function remoteTooLarge(path: string): SshConnectionError {
  return new SshConnectionError('REMOTE_FILE_TOO_LARGE', `远程文件超过单文件同步限制：${path}`)
}

function hashingTransform(maximumBytes: number, tooLarge: () => Error): {
  readonly stream: Transform
  readonly result: () => StreamedFileResult
} {
  const hash = createHash('sha256')
  let size = 0
  const stream = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += value.length
      if (size > maximumBytes) {
        callback(tooLarge())
        return
      }
      hash.update(value)
      callback(null, value)
    },
  })
  return { stream, result: () => ({ hash: hash.digest('hex'), size }) }
}

function hashingSink(maximumBytes: number, tooLarge: () => Error): {
  readonly stream: Writable
  readonly result: () => StreamedFileResult
} {
  const hash = createHash('sha256')
  let size = 0
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += value.length
      if (size > maximumBytes) {
        callback(tooLarge())
        return
      }
      hash.update(value)
      callback()
    },
  })
  return { stream, result: () => ({ hash: hash.digest('hex'), size }) }
}

function assertRemoteFile(info: RemoteFileStat | undefined, path: string, maximumBytes: number): RemoteFileStat {
  if (info === undefined || info.kind !== 'file') throw new SshConnectionError('REMOTE_FILE_MISSING', `远程文件不存在：${path}`)
  if (info.size > maximumBytes) throw remoteTooLarge(path)
  return info
}

function sameRemoteSnapshot(left: RemoteFileStat, right: RemoteFileStat): boolean {
  return left.kind === right.kind && left.size === right.size && left.mtimeMs === right.mtimeMs
}

/** Compatibility helper for small callers. Workspace synchronization uses the streaming APIs below. */
export async function sftpReadFile(sftp: SFTPWrapper, path: string, maximumBytes = 256 * 1024 * 1024): Promise<Buffer> {
  const info = await sftpStat(sftp, path)
  assertRemoteFile(info, path, maximumBytes)
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const stream = sftp.createReadStream(path)
    stream.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += value.length
      if (total > maximumBytes) stream.destroy(new SshConnectionError('REMOTE_FILE_TOO_LARGE', `远程文件超过单文件同步限制：${path}`))
      else chunks.push(value)
    })
    stream.once('error', reject)
    stream.once('end', () => resolve(Buffer.concat(chunks, total)))
  })
}

/** Hash one remote file without buffering its contents. */
export async function sftpHashFile(sftp: SFTPWrapper, path: string, maximumBytes: number): Promise<StreamedFileResult> {
  const before = assertRemoteFile(await sftpStat(sftp, path), path, maximumBytes)
  const hashing = hashingSink(maximumBytes, () => remoteTooLarge(path))
  await pipeline(sftp.createReadStream(path), hashing.stream)
  const result = hashing.result()
  const after = assertRemoteFile(await sftpStat(sftp, path), path, maximumBytes)
  if (result.size !== before.size || !sameRemoteSnapshot(before, after)) {
    throw new SshConnectionError('REMOTE_FILE_CHANGED', `远程文件在同步过程中发生变化，请重试：${path}`)
  }
  return result
}

/** Download one remote file atomically while hashing it, with bounded memory use. */
export async function sftpDownloadFileAtomic(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  maximumBytes: number,
): Promise<StreamedFileResult> {
  const before = assertRemoteFile(await sftpStat(sftp, remotePath), remotePath, maximumBytes)
  await mkdir(dirname(localPath), { recursive: true })
  const temporary = `${localPath}.dsh-download-${process.pid}-${randomUUID()}`
  const hashing = hashingTransform(maximumBytes, () => remoteTooLarge(remotePath))
  try {
    await pipeline(
      sftp.createReadStream(remotePath),
      hashing.stream,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    )
    const result = hashing.result()
    const after = assertRemoteFile(await sftpStat(sftp, remotePath), remotePath, maximumBytes)
    if (result.size !== before.size || !sameRemoteSnapshot(before, after)) {
      throw new SshConnectionError('REMOTE_FILE_CHANGED', `远程文件在同步过程中发生变化，请重试：${remotePath}`)
    }
    // Windows requires a writable handle for FlushFileBuffers/fsync.
    const handle = await open(temporary, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await renameLocal(temporary, localPath)
    return result
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function sftpMkdirOne(sftp: SFTPWrapper, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(path, { mode: 0o755 }, (error) => {
      if (error === undefined || error === null || (error as NodeJS.ErrnoException).code === 'EEXIST' || /failure/iu.test(String(error))) resolve()
      else reject(error)
    })
  })
  const info = await sftpStat(sftp, path)
  if (info?.kind !== 'directory') throw new SshConnectionError('REMOTE_MKDIR_FAILED', `无法创建远程目录：${path}`)
}

export async function sftpMkdirp(sftp: SFTPWrapper, path: string): Promise<void> {
  const normalized = posix.normalize(path)
  const parts = normalized.split('/').filter(Boolean)
  let current = normalized.startsWith('/') ? '/' : ''
  for (const part of parts) {
    current = current === '/' ? `/${part}` : current === '' ? part : `${current}/${part}`
    const info = await sftpStat(sftp, current)
    if (info === undefined) await sftpMkdirOne(sftp, current)
    else if (info.kind !== 'directory') throw new SshConnectionError('REMOTE_PATH_CONFLICT', `远程路径不是目录：${current}`)
  }
}

async function commitSftpTemporary(sftp: SFTPWrapper, temporary: string, path: string): Promise<void> {
  const rename = async (from: string, to: string): Promise<void> => await new Promise<void>((resolve, reject) => {
    sftp.rename(from, to, error => error === undefined ? resolve() : reject(error))
  })
  const unlinkQuietly = async (target: string): Promise<void> => await new Promise<void>(resolve => sftp.unlink(target, () => resolve()))
  try {
    // OpenSSH's POSIX rename extension atomically replaces an existing target.
    // Some enterprise SFTP servers expose only baseline rename, whose RENAME
    // returns generic “Failure” when the destination exists.
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.ext_openssh_rename(temporary, path, error => error === undefined ? resolve() : reject(error))
      })
    } catch (extensionError) {
      const existing = await sftpStat(sftp, path)
      if (existing === undefined) {
        await rename(temporary, path)
      } else {
        const backup = `${path}.dsh-replace-backup-${process.pid}-${randomUUID()}`
        await rename(path, backup)
        try {
          await rename(temporary, path)
        } catch (replaceError) {
          try { await rename(backup, path) } catch (rollbackError) {
            throw new AggregateError([extensionError, replaceError, rollbackError], `远程文件替换和回滚都失败：${path}`)
          }
          throw replaceError
        }
        await unlinkQuietly(backup)
      }
    }
  } catch (error) {
    await unlinkQuietly(temporary)
    throw error
  }
}

export async function sftpWriteFileAtomic(sftp: SFTPWrapper, path: string, content: Buffer): Promise<RemoteFileStat> {
  await sftpMkdirp(sftp, posix.dirname(path))
  const existing = await sftpStat(sftp, path)
  const temporary = `${path}.dsh-upload-${process.pid}-${randomUUID()}`
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createWriteStream(temporary, {
      flags: 'wx',
      mode: existing?.kind === 'file' ? existing.mode & 0o777 : 0o600,
    })
    stream.once('error', reject)
    stream.once('close', resolve)
    stream.end(content)
  })
  await commitSftpTemporary(sftp, temporary, path)
  const info = await sftpStat(sftp, path)
  if (info?.kind !== 'file') throw new SshConnectionError('REMOTE_WRITE_FAILED', `远程文件写入后无法读取：${path}`)
  return info
}

/** Upload one local file atomically while hashing it, with bounded memory use. */
export async function sftpWriteFileFromPathAtomic(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  maximumBytes: number,
): Promise<StreamedRemoteWriteResult> {
  const localInfo = await stat(localPath)
  if (!localInfo.isFile()) throw new SshConnectionError('LOCAL_FILE_MISSING', `本地文件不存在：${localPath}`)
  if (localInfo.size > maximumBytes) throw new SshConnectionError('LOCAL_FILE_TOO_LARGE', `本地文件超过单文件同步限制：${localPath}`)
  await sftpMkdirp(sftp, posix.dirname(remotePath))
  const existing = await sftpStat(sftp, remotePath)
  const temporary = `${remotePath}.dsh-upload-${process.pid}-${randomUUID()}`
  const hashing = hashingTransform(maximumBytes, () => new SshConnectionError('LOCAL_FILE_TOO_LARGE', `本地文件超过单文件同步限制：${localPath}`))
  try {
    await pipeline(
      createReadStream(localPath),
      hashing.stream,
      sftp.createWriteStream(temporary, {
        flags: 'wx',
        mode: existing?.kind === 'file' ? existing.mode & 0o777 : 0o600,
      }),
    )
    const result = hashing.result()
    const currentLocal = await stat(localPath)
    if (result.size !== localInfo.size || currentLocal.size !== localInfo.size || currentLocal.mtimeMs !== localInfo.mtimeMs) {
      throw new SshConnectionError('LOCAL_FILE_CHANGED', `本地文件在同步过程中发生变化，请重试：${localPath}`)
    }
    const staged = assertRemoteFile(await sftpStat(sftp, temporary), temporary, maximumBytes)
    if (staged.size !== result.size) {
      throw new SshConnectionError('REMOTE_WRITE_INCOMPLETE', `远程临时文件大小不完整：${remotePath}`)
    }
    await commitSftpTemporary(sftp, temporary, remotePath)
    const remoteInfo = assertRemoteFile(await sftpStat(sftp, remotePath), remotePath, maximumBytes)
    if (remoteInfo.size !== result.size) {
      throw new SshConnectionError('REMOTE_WRITE_INCOMPLETE', `远程文件写入大小不完整：${remotePath}`)
    }
    return { ...result, stat: remoteInfo }
  } catch (error) {
    await new Promise<void>(resolve => sftp.unlink(temporary, () => resolve()))
    throw error
  }
}

export async function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.unlink(path, error => error === undefined || (error as NodeJS.ErrnoException).code === 'ENOENT' ? resolve() : reject(error))
  })
}

export async function sftpRmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(path, error => error === undefined || (error as NodeJS.ErrnoException).code === 'ENOENT' ? resolve() : reject(error))
  })
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function execSshCommand(
  client: Client,
  cwd: string,
  command: string,
  signal?: AbortSignal,
  outputLimit = 8 * 1024 * 1024,
): Promise<RemoteCommandResult> {
  signal?.throwIfAborted()
  // Never request a login shell here. Enterprise /etc/profile scripts often
  // print banners, disk reports, or even unrelated mount warnings; those
  // bytes would corrupt a tool's stdout/stderr contract. Interactive PTYs
  // remain login-like and may show the server's normal welcome content.
  const wrapped = `cd -- ${shQuote(cwd)} && /bin/sh -c ${shQuote(command)}`
  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    client.exec(wrapped, (error, stream) => error !== undefined ? reject(error) : resolve(stream))
  })
  return await new Promise<RemoteCommandResult>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let total = 0
    let settled = false
    const abort = (): void => {
      try { channel.close() } catch { /* already closed */ }
      if (!settled) reject(signal?.reason instanceof Error ? signal.reason : new Error('命令已取消'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    const append = (target: Buffer[], chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += value.length
      if (total > outputLimit) {
        try { channel.close() } catch { /* already closed */ }
        reject(new SshConnectionError('REMOTE_OUTPUT_LIMIT', '远程命令输出超过限制'))
        settled = true
        return
      }
      target.push(value)
    }
    channel.on('data', (chunk: Buffer | string) => append(stdout, chunk))
    channel.stderr.on('data', (chunk: Buffer | string) => append(stderr, chunk))
    channel.once('error', (error: Error) => { if (!settled) { settled = true; reject(error) } })
    channel.once('close', (code: number | null, signalName?: string) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code,
        ...(signalName === undefined ? {} : { signal: signalName }),
      })
    })
  })
}

export function connectionSpec(profile: SshWorkspaceProfile, credential?: SshCredentialPayload): SshConnectionSpec {
  return {
    id: profile.id,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMode: profile.authMode,
    hostFingerprint: profile.hostFingerprint,
    ...(credential === undefined ? {} : { credential }),
  }
}
