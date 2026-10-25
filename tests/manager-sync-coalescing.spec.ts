import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ syncSshWorkspace: vi.fn() }))

vi.mock('../src/sync-engine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync-engine.ts')>()
  return { ...actual, syncSshWorkspace: mocks.syncSshWorkspace }
})

import { SshWorkspaceManager } from '../src/manager.ts'
import { SshBulkDeletionError } from '../src/sync-engine.ts'
import type { SshWorkspaceProfile } from '../src/types.ts'

class MemoryCredentials {
  readonly records = new Map<string, CredentialRecord>()
  async readRecord(key: unknown) { return this.records.get(String(key)) }
  async describeRecord(key: unknown) { return { configured: this.records.has(String(key)), writable: true } }
  async listRecords() { return [] }
  async modifyRecord(key: unknown, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const value = await mutate(this.records.get(String(key)))
    if (value === undefined) this.records.delete(String(key))
    else this.records.set(String(key), value)
    return value
  }
  async deleteRecord(key: unknown) { this.records.delete(String(key)) }
}

const roots: string[] = []

afterEach(async () => {
  mocks.syncSshWorkspace.mockReset()
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true })
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-manager-'))
  roots.push(home)
  const credentials = new MemoryCredentials()
  const manager = new SshWorkspaceManager(
    credentials as unknown as CredentialProvider,
    {} as Pick<WorkspaceRegistry, 'create' | 'resolveByPath' | 'delete'>,
    home,
  )
  const id = manager.profiles.newId()
  const now = new Date().toISOString()
  const profile: SshWorkspaceProfile = {
    id,
    name: 'remote',
    host: 'server.example',
    port: 22,
    username: 'user',
    remotePath: '/srv/project',
    cachePath: manager.profiles.cachePath(id),
    hostFingerprint: `SHA256:${'A'.repeat(43)}`,
    authMode: 'openssh-config',
    transportMode: 'system', openSshHost: 'test-fixture', helperMode: 'auto', terminalGraceSeconds: 300,
    portForwards: [],
    pollIntervalMs: 5_000,
    excludes: ['.git', 'node_modules'],
    createdAt: now,
    updatedAt: now,
  }
  await manager.profiles.put(profile)
  return { manager, profile }
}

describe('SSH manager synchronization scheduling', () => {
  it('coalesces overlapping polls into one physical SSH synchronization', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mocks.syncSshWorkspace.mockImplementation(async () => {
      await gate
      return {
        remoteRoot: f.profile.remotePath,
        filesPulled: 0,
        filesPushed: 0,
        filesDeletedLocally: 0,
        filesDeletedRemotely: 0,
        conflicts: [],
        scannedFiles: 0,
        completedAt: new Date().toISOString(),
      }
    })

    const first = f.manager.sync(f.profile.id)
    const second = f.manager.sync(f.profile.id)
    await vi.waitFor(() => expect(mocks.syncSshWorkspace).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([first, second])
    expect(mocks.syncSshWorkspace).toHaveBeenCalledTimes(1)
    f.manager.dispose()
  })

  it('reports an unknown profile instead of silently returning an idle status', async () => {
    const f = await fixture()
    const status = await f.manager.sync('ssh-00000000-0000-4000-8000-000000000099')
    expect(status.phase).toBe('error')
    expect(status.lastError).toContain('远程工作区不存在')
    expect(mocks.syncSshWorkspace).not.toHaveBeenCalled()
    f.manager.dispose()
  })

  it('surfaces bulk deletion details for an explicit user confirmation flow', async () => {
    const f = await fixture()
    mocks.syncSshWorkspace.mockRejectedValueOnce(new SshBulkDeletionError(120, 200))
    const status = await f.manager.sync(f.profile.id)
    expect(status).toMatchObject({
      phase: 'error',
      deletionGuard: { candidateCount: 120, trackedCount: 200 },
    })
    f.manager.dispose()
  })
})
