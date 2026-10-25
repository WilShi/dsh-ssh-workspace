import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SshProfileStore } from '../src/profile-store.ts'

const roots: string[] = []
afterEach(async () => { while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true }) })

describe('secret-free SSH profile persistence', () => {
  it('stores only public connection metadata with a stable cache path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-profiles-'))
    roots.push(home)
    const store = new SshProfileStore(home)
    const id = store.newId()
    const now = new Date().toISOString()
    await store.put({
      id, name: 'server', host: '10.0.0.1', port: 22, username: 'user', remotePath: '/srv/project',
      cachePath: store.cachePath(id), hostFingerprint: `SHA256:${'A'.repeat(43)}`, authMode: 'password',
      transportMode: 'auto', helperMode: 'auto', terminalGraceSeconds: 300,
      portForwards: [],
      pollIntervalMs: 5_000, excludes: ['.git', 'node_modules', '.dsh-conflicts'], createdAt: now, updatedAt: now,
    })
    const raw = await readFile(store.filename, 'utf8')
    expect(raw).toContain('10.0.0.1')
    expect(raw).not.toMatch(/"password"\s*:|"privateKey"\s*:|"passphrase"\s*:|top-secret/iu)
    expect((await store.list())[0]?.cachePath).toBe(store.cachePath(id))
  })

  it('loads profiles written before helper, terminal and forwarding fields existed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-profiles-'))
    roots.push(home)
    const store = new SshProfileStore(home)
    const id = store.newId()
    const now = new Date().toISOString()
    await mkdir(store.directory, { recursive: true })
    await writeFile(store.filename, JSON.stringify({
      version: 1,
      profiles: [{
        id, name: 'legacy', host: '10.0.0.2', port: 22, username: 'user', remotePath: '/srv/legacy',
        cachePath: store.cachePath(id), hostFingerprint: `SHA256:${'B'.repeat(43)}`, authMode: 'password',
        pollIntervalMs: 5_000, excludes: ['.git', 'node_modules', '.dsh-conflicts'], createdAt: now, updatedAt: now,
      }],
    }))

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id, workspaceMode: 'mirror', transportMode: 'auto', helperMode: 'auto', terminalGraceSeconds: 300, portForwards: [],
      }),
    ])
  })
})
