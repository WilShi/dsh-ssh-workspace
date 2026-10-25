import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { SshWorkspaceManager } from '../src/manager.ts'

const roots: string[] = []
afterEach(async () => { while (roots.length > 0) await rm(roots.pop() as string, { force: true, recursive: true }) })

describe('direct workspace legacy cache cleanup', () => {
  it('removes only children of the owned cache root and preserves its marker', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-direct-cache-'))
    roots.push(home)
    const manager = new SshWorkspaceManager(
      {} as CredentialProvider,
      { create: async () => { throw new Error('unused') }, resolveByPath: async () => undefined, delete: async () => {} } as unknown as WorkspaceRegistry,
      home,
    )
    const id = manager.profiles.newId()
    const cachePath = manager.profiles.cachePath(id)
    const now = new Date().toISOString()
    await mkdir(join(cachePath, 'old-directory'), { recursive: true })
    await Promise.all([
      writeFile(join(cachePath, '.dsh-remote-workspace.json'), '{}\n'),
      writeFile(join(cachePath, 'old-file.tar'), 'old'),
      writeFile(join(cachePath, 'old-directory', 'nested.txt'), 'old'),
    ])
    await manager.profiles.put({
      id, name: 'Direct', host: 'server', port: 22, username: 'user', remotePath: '/srv', cachePath,
      workspaceMode: 'direct', hostFingerprint: `SHA256:${'A'.repeat(43)}`, authMode: 'agent', transportMode: 'builtin',
      helperMode: 'auto', terminalGraceSeconds: 300, portForwards: [], pollIntervalMs: 5_000,
      excludes: ['.git', 'node_modules', '.dsh-conflicts'], createdAt: now, updatedAt: now,
    })

    await expect(manager.clearDirectCache(id)).resolves.toBe(2)
    await expect(readdir(cachePath)).resolves.toEqual(['.dsh-remote-workspace.json'])
    manager.dispose()
  })
})
