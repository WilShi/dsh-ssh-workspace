import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteFileEntry, RemoteFileStat } from '../src/ssh-client.ts'
import {
  assertSshSyncFileSize,
  assertSshSyncTotalSize,
  readSyncManifest,
  reconcileWorkspace,
  SSH_SYNC_LIMITS,
  type SyncRemote,
} from '../src/sync-engine.ts'
import type { SshWorkspaceProfile } from '../src/types.ts'

class MemoryRemote implements SyncRemote {
  readonly root = '/srv/project'
  readonly files = new Map<string, { content: Buffer; revision: number }>()
  readonly directories = new Set<string>()
  private clock = 1

  set(path: string, content: string): void {
    this.files.set(path, { content: Buffer.from(content), revision: this.clock++ })
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) this.directories.add(parts.slice(0, index).join('/'))
  }

  get(path: string): string | undefined {
    return this.files.get(path)?.content.toString('utf8')
  }

  async scan(excludes: ReadonlySet<string>) {
    const files = new Map<string, RemoteFileEntry>()
    let totalBytes = 0
    for (const [path, value] of this.files) {
      if (path.split('/').some(segment => excludes.has(segment))) continue
      totalBytes += value.content.length
      files.set(path, {
        path: `${this.root}/${path}`,
        kind: 'file',
        size: value.content.length,
        mtimeMs: value.revision * 1_000,
        mode: 0o100644,
      })
    }
    return { files, directories: new Set(this.directories), totalBytes }
  }

  async stat(path: string): Promise<RemoteFileStat | undefined> {
    const value = this.files.get(path)
    return value === undefined ? undefined : {
      kind: 'file', size: value.content.length, mtimeMs: value.revision * 1_000, mode: 0o100644,
    }
  }

  async hash(path: string) {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`missing ${path}`)
    return { hash: createHash('sha256').update(value.content).digest('hex'), size: value.content.length }
  }

  async download(path: string, localPath: string) {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`missing ${path}`)
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, value.content)
    return await this.hash(path)
  }

  async upload(path: string, localPath: string) {
    const content = await readFile(localPath)
    this.files.set(path, { content: Buffer.from(content), revision: this.clock++ })
    return {
      hash: createHash('sha256').update(content).digest('hex'),
      size: content.length,
      stat: await this.stat(path) as RemoteFileStat,
    }
  }

  async mkdir(path: string): Promise<void> { this.directories.add(path) }
  async unlink(path: string): Promise<void> { this.files.delete(path) }
}

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-sync-'))
  roots.push(root)
  const cachePath = join(root, 'cache')
  const manifestPath = join(root, 'manifest.json')
  const profile: SshWorkspaceProfile = {
    id: 'ssh-00000000-0000-4000-8000-000000000000',
    name: 'test', host: 'server', port: 22, username: 'user', remotePath: '/srv/project', cachePath,
    hostFingerprint: `SHA256:${'A'.repeat(43)}`, authMode: 'agent',
    transportMode: 'auto', helperMode: 'auto', terminalGraceSeconds: 300, pollIntervalMs: 5_000,
    portForwards: [],
    excludes: ['.git', 'node_modules', '.dsh-conflicts'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  }
  return { root, cachePath, manifestPath, profile, remote: new MemoryRemote() }
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true })
})

describe('conflict-safe bidirectional synchronization', () => {
  it('uses the expanded large-workspace limits', () => {
    expect(SSH_SYNC_LIMITS).toEqual({
      maxEntries: 50_000,
      maxTotalBytes: 100 * 1024 * 1024 * 1024,
      maxFileBytes: 6 * 1024 * 1024 * 1024,
    })
  })

  it('enforces the 6 GiB file and 100 GiB workspace boundaries without allocating large files', () => {
    expect(() => assertSshSyncFileSize(SSH_SYNC_LIMITS.maxFileBytes, 'large-image.iso')).not.toThrow()
    expect(() => assertSshSyncFileSize(SSH_SYNC_LIMITS.maxFileBytes + 1, 'too-large.iso')).toThrow(/6GB/u)
    expect(() => assertSshSyncTotalSize(SSH_SYNC_LIMITS.maxTotalBytes, 'local')).not.toThrow()
    expect(() => assertSshSyncTotalSize(SSH_SYNC_LIMITS.maxTotalBytes + 1, 'remote')).toThrow(/100GB/u)
  })

  it('pulls remote files, pushes a later local edit, and then pulls a remote edit', async () => {
    const f = await fixture()
    f.remote.set('src/index.ts', 'remote-v1')
    const first = await reconcileWorkspace(f.profile, f.manifestPath, f.remote)
    expect(first.filesPulled).toBe(1)
    expect(await readFile(join(f.cachePath, 'src/index.ts'), 'utf8')).toBe('remote-v1')

    await writeFile(join(f.cachePath, 'src/index.ts'), 'local-v2')
    const second = await reconcileWorkspace(f.profile, f.manifestPath, f.remote)
    expect(second.filesPushed).toBe(1)
    expect(f.remote.get('src/index.ts')).toBe('local-v2')

    f.remote.set('src/index.ts', 'remote-v3')
    const third = await reconcileWorkspace(f.profile, f.manifestPath, f.remote)
    expect(third.filesPulled).toBe(1)
    expect(await readFile(join(f.cachePath, 'src/index.ts'), 'utf8')).toBe('remote-v3')
  })

  it('reuses a stable local snapshot instead of hashing every file on every poll', async () => {
    const f = await fixture()
    f.remote.set('src/index.ts', 'remote-v1')
    await reconcileWorkspace(f.profile, f.manifestPath, f.remote)

    let hashCalls = 0
    const stable = await reconcileWorkspace(f.profile, f.manifestPath, f.remote, {
      hashLocal: async () => { hashCalls++; return 'unexpected' },
    })
    expect(stable.filesPulled).toBe(0)
    expect(stable.filesPushed).toBe(0)
    expect(hashCalls).toBe(0)

    const file = join(f.cachePath, 'src/index.ts')
    const later = new Date(Date.now() + 5_000)
    await utimes(file, later, later)
    const expected = createHash('sha256').update('remote-v1').digest('hex')
    await reconcileWorkspace(f.profile, f.manifestPath, f.remote, {
      hashLocal: async () => { hashCalls++; return expected },
    })
    expect(hashCalls).toBe(1)
    await reconcileWorkspace(f.profile, f.manifestPath, f.remote, {
      hashLocal: async () => { hashCalls++; return expected },
    })
    expect(hashCalls).toBe(1)
  })

  it('upgrades legacy manifests without a local snapshot on the next safe synchronization', async () => {
    const f = await fixture()
    f.remote.set('README.md', 'legacy-content')
    await reconcileWorkspace(f.profile, f.manifestPath, f.remote)
    const current = await readSyncManifest(f.manifestPath, f.profile.id, f.remote.root)
    const legacy = {
      ...current,
      entries: {
        ...current.entries,
        'README.md': {
          ...current.entries['README.md'],
          localRevision: undefined,
        },
      },
    }
    await writeFile(f.manifestPath, `${JSON.stringify(legacy)}\n`)

    let hashCalls = 0
    const expected = createHash('sha256').update('legacy-content').digest('hex')
    await reconcileWorkspace(f.profile, f.manifestPath, f.remote, {
      hashLocal: async () => { hashCalls++; return expected },
    })
    expect(hashCalls).toBe(1)
    const upgraded = await readSyncManifest(f.manifestPath, f.profile.id, f.remote.root)
    expect(upgraded.entries['README.md']?.localRevision).toMatch(/:/u)
  })

  it('halts suspicious bulk deletion until the caller explicitly confirms it', async () => {
    const f = await fixture()
    for (let index = 0; index < 100; index++) f.remote.set(`bulk/file-${index}.txt`, String(index))
    await reconcileWorkspace(f.profile, f.manifestPath, f.remote)
    f.remote.files.clear()

    await expect(reconcileWorkspace(f.profile, f.manifestPath, f.remote)).rejects.toEqual(
      expect.objectContaining({
        code: 'BULK_DELETE_CONFIRMATION_REQUIRED',
        candidateCount: 100,
        trackedCount: 100,
      }),
    )
    expect(await readFile(join(f.cachePath, 'bulk/file-0.txt'), 'utf8')).toBe('0')

    const confirmed = await reconcileWorkspace(f.profile, f.manifestPath, f.remote, { allowBulkDelete: true })
    expect(confirmed.filesDeletedLocally).toBe(100)
    await expect(readFile(join(f.cachePath, 'bulk/file-0.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never overwrites either side when local and remote both changed', async () => {
    const f = await fixture()
    f.remote.set('README.md', 'base')
    await reconcileWorkspace(f.profile, f.manifestPath, f.remote)
    await writeFile(join(f.cachePath, 'README.md'), 'local-change')
    f.remote.set('README.md', 'remote-change')

    const report = await reconcileWorkspace(f.profile, f.manifestPath, f.remote)
    expect(report.conflicts).toHaveLength(1)
    expect(await readFile(join(f.cachePath, 'README.md'), 'utf8')).toBe('local-change')
    expect(f.remote.get('README.md')).toBe('remote-change')
    const copy = report.conflicts[0]?.copyPath
    expect(copy).toBeTruthy()
    expect(await readFile(join(f.cachePath, copy as string), 'utf8')).toBe('remote-change')
  })

  it('propagates unchanged-file deletions in both directions', async () => {
    const f = await fixture()
    f.remote.set('remote-delete.txt', 'one')
    f.remote.set('local-delete.txt', 'two')
    await reconcileWorkspace(f.profile, f.manifestPath, f.remote)

    f.remote.files.delete('remote-delete.txt')
    await unlink(join(f.cachePath, 'local-delete.txt'))
    const report = await reconcileWorkspace(f.profile, f.manifestPath, f.remote)
    expect(report.filesDeletedLocally).toBe(1)
    expect(report.filesDeletedRemotely).toBe(1)
    await expect(readFile(join(f.cachePath, 'remote-delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.remote.get('local-delete.txt')).toBeUndefined()

    const manifest = await readSyncManifest(f.manifestPath, f.profile.id, f.remote.root)
    expect(manifest.entries).toEqual({})
  })
})
