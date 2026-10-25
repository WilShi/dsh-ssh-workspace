import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { SFTPWrapper, Stats } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import {
  sftpDownloadFileAtomic,
  sftpHashFile,
  sftpWriteFileFromPathAtomic,
} from '../src/ssh-client.ts'

interface FakeEntry {
  content?: Buffer
  mode: number
}

function attrs(entry: FakeEntry): Stats {
  const isFile = entry.content !== undefined
  return {
    size: entry.content?.length ?? 0,
    uid: 0,
    gid: 0,
    mode: entry.mode,
    atime: 1,
    mtime: 1,
    isDirectory: () => !isFile,
    isFile: () => isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  }
}

function fakeSftp(initial: Record<string, FakeEntry>, hooks: { beforeUploadFinalize?: () => Promise<void> } = {}): {
  sftp: SFTPWrapper
  entries: Map<string, FakeEntry>
  uploadModes: number[]
} {
  const entries = new Map(Object.entries(initial))
  const uploadModes: number[] = []
  const missing = (): NodeJS.ErrnoException => Object.assign(new Error('No such file'), { code: 'ENOENT' })
  const implementation = {
    lstat(path: string, callback: (error: Error | undefined, value: Stats) => void) {
      const entry = entries.get(path)
      if (entry === undefined) callback(missing(), undefined as unknown as Stats)
      else callback(undefined, attrs(entry))
    },
    createReadStream(path: string) {
      const entry = entries.get(path)
      return Readable.from(entry?.content === undefined ? [] : [entry.content.subarray(0, 2), entry.content.subarray(2)])
    },
    createWriteStream(path: string, options: { mode?: number } = {}) {
      const chunks: Buffer[] = []
      uploadModes.push(options.mode ?? 0)
      return new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          callback()
        },
        final(callback) {
          void (async () => {
            await hooks.beforeUploadFinalize?.()
            entries.set(path, { content: Buffer.concat(chunks), mode: 0o100000 | (options.mode ?? 0o600) })
          })().then(() => callback(), error => callback(error instanceof Error ? error : new Error(String(error))))
        },
      })
    },
    ext_openssh_rename(from: string, to: string, callback: (error?: Error) => void) {
      const entry = entries.get(from)
      if (entry === undefined) { callback(missing()); return }
      entries.set(to, entry)
      entries.delete(from)
      callback()
    },
    rename(from: string, to: string, callback: (error?: Error) => void) {
      const entry = entries.get(from)
      if (entry === undefined) { callback(missing()); return }
      entries.set(to, entry)
      entries.delete(from)
      callback()
    },
    unlink(path: string, callback: (error?: Error) => void) {
      entries.delete(path)
      callback()
    },
  }
  return { sftp: implementation as unknown as SFTPWrapper, entries, uploadModes }
}

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true })
})

describe('streamed SFTP file operations', () => {
  it('hashes and downloads in chunks, then atomically replaces the local target', async () => {
    const content = Buffer.from('streamed-download-content')
    const { sftp } = fakeSftp({ '/srv/file.bin': { content, mode: 0o100640 } })
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-stream-'))
    roots.push(root)
    const target = join(root, 'file.bin')
    await writeFile(target, 'old')

    const expectedHash = createHash('sha256').update(content).digest('hex')
    await expect(sftpHashFile(sftp, '/srv/file.bin', 1024)).resolves.toEqual({ hash: expectedHash, size: content.length })
    await expect(sftpDownloadFileAtomic(sftp, '/srv/file.bin', target, 1024)).resolves.toEqual({ hash: expectedHash, size: content.length })
    expect(await readFile(target)).toEqual(content)
  })

  it('streams an upload through a temporary file and preserves the destination mode', async () => {
    const content = Buffer.from('streamed-upload-content')
    const { sftp, entries, uploadModes } = fakeSftp({
      '/': { mode: 0o040755 },
      '/srv': { mode: 0o040755 },
      '/srv/file.bin': { content: Buffer.from('old'), mode: 0o100640 },
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-stream-'))
    roots.push(root)
    const source = join(root, 'file.bin')
    await writeFile(source, content)

    const result = await sftpWriteFileFromPathAtomic(sftp, '/srv/file.bin', source, 1024)
    expect(entries.get('/srv/file.bin')?.content).toEqual(content)
    expect(uploadModes).toContain(0o640)
    expect([...entries.keys()].some(path => path.includes('.dsh-upload-'))).toBe(false)
    expect(result).toMatchObject({
      hash: createHash('sha256').update(content).digest('hex'),
      size: content.length,
    })
  })

  it('aborts a stream that exceeds its declared maximum', async () => {
    const { sftp } = fakeSftp({ '/srv/file.bin': { content: Buffer.from('1234'), mode: 0o100600 } })
    await expect(sftpHashFile(sftp, '/srv/file.bin', 3)).rejects.toMatchObject({ code: 'REMOTE_FILE_TOO_LARGE' })
  })

  it('rejects a remote file that changes while it is being hashed', async () => {
    const content = Buffer.from('changing-content')
    let statCalls = 0
    const implementation = {
      lstat(_path: string, callback: (error: Error | undefined, value: Stats) => void) {
        const value = attrs({ content, mode: 0o100600 })
        callback(undefined, { ...value, mtime: ++statCalls })
      },
      createReadStream() { return Readable.from([content]) },
    }
    await expect(sftpHashFile(implementation as unknown as SFTPWrapper, '/srv/file.bin', 1024))
      .rejects.toMatchObject({ code: 'REMOTE_FILE_CHANGED' })
  })

  it('keeps the previous local file when the remote source changes during download', async () => {
    const content = Buffer.from('changing-download')
    let statCalls = 0
    const implementation = {
      lstat(_path: string, callback: (error: Error | undefined, value: Stats) => void) {
        const value = attrs({ content, mode: 0o100600 })
        callback(undefined, { ...value, mtime: ++statCalls })
      },
      createReadStream() { return Readable.from([content]) },
    }
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-stream-'))
    roots.push(root)
    const target = join(root, 'file.bin')
    await writeFile(target, 'previous-local-content')

    await expect(sftpDownloadFileAtomic(implementation as unknown as SFTPWrapper, '/srv/file.bin', target, 1024))
      .rejects.toMatchObject({ code: 'REMOTE_FILE_CHANGED' })
    expect(await readFile(target, 'utf8')).toBe('previous-local-content')
  })

  it('does not replace the remote destination when the local source changes during upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-stream-'))
    roots.push(root)
    const source = join(root, 'file.bin')
    await writeFile(source, 'initial-content')
    const { sftp, entries } = fakeSftp({
      '/': { mode: 0o040755 },
      '/srv': { mode: 0o040755 },
      '/srv/file.bin': { content: Buffer.from('remote-original'), mode: 0o100600 },
    }, {
      beforeUploadFinalize: async () => { await writeFile(source, 'changed-during-upload-with-a-different-size') },
    })

    await expect(sftpWriteFileFromPathAtomic(sftp, '/srv/file.bin', source, 1024))
      .rejects.toMatchObject({ code: 'LOCAL_FILE_CHANGED' })
    expect(entries.get('/srv/file.bin')?.content?.toString('utf8')).toBe('remote-original')
    expect([...entries.keys()].some(path => path.includes('.dsh-upload-'))).toBe(false)
  })
})
