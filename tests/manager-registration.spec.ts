import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  syncSshWorkspace: vi.fn(),
  closeRemoteWatch: vi.fn(),
}))

vi.mock('../src/sync-engine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync-engine.ts')>()
  return { ...actual, syncSshWorkspace: mocks.syncSshWorkspace }
})

vi.mock('../src/remote-watch.ts', () => ({
  startRemoteFileWatch: vi.fn(() => ({ close: mocks.closeRemoteWatch })),
}))

import { SshWorkspaceManager } from '../src/manager.ts'
import { SshProfileStore } from '../src/profile-store.ts'

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
  mocks.closeRemoteWatch.mockReset()
  vi.restoreAllMocks()
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true })
})

async function fixture(options: { existingWorkspace?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-registration-'))
  roots.push(home)
  const workspace = {
    id: 'workspace-remote-1',
    title: options.existingWorkspace === true ? 'old title' : 'Remote project',
    setTitle: vi.fn(async function setTitle(this: { title: string }, title: string) { this.title = title }),
  }
  const resolveByPath = vi.fn(async () => options.existingWorkspace === true ? workspace : undefined)
  const create = vi.fn(async () => workspace)
  const registry = {
    resolveByPath,
    create,
    delete: vi.fn(),
  } as unknown as Pick<WorkspaceRegistry, 'create' | 'resolveByPath' | 'delete'>
  const manager = new SshWorkspaceManager(
    new MemoryCredentials() as unknown as CredentialProvider,
    registry,
    home,
  )
  const fingerprint = `SHA256:${'A'.repeat(43)}`
  vi.spyOn(manager, 'probe').mockResolvedValue({
    ok: true,
    fingerprint,
    remotePath: '/srv/project',
    remoteRealPath: '/srv/project',
    capabilities: {
      transport: 'system', sftp: true, helper: false, realtimeFileEvents: false,
      persistentTerminals: false, portDiscovery: true, portForwarding: true,
      proxyJump: true, keyboardInteractive: true,
    },
  })
  mocks.syncSshWorkspace.mockResolvedValue({
    remoteRoot: '/srv/project', filesPulled: 1, filesPushed: 0,
    filesDeletedLocally: 0, filesDeletedRemotely: 0, conflicts: [],
    scannedFiles: 1, completedAt: new Date().toISOString(),
  })
  const input = {
    name: 'Remote project', host: 'server.example', port: 22, username: 'developer',
    remotePath: '/srv/project', workspaceMode: 'mirror' as const, hostFingerprint: fingerprint,
    authMode: 'openssh-config' as const, transportMode: 'system' as const,
    openSshHost: 'test-server', helperMode: 'auto' as const,
    terminalGraceSeconds: 300, pollIntervalMs: 60_000,
    excludes: ['.git', 'node_modules', '.dsh-conflicts'],
  }
  return { home, manager, workspace, resolveByPath, create, input }
}

describe('SSH workspace registration and persistence', () => {
  it('registers the synchronized cache as a native workspace and persists its id', async () => {
    const f = await fixture()
    try {
      const saved = await f.manager.saveAndCreate(f.input)
      expect(f.resolveByPath).toHaveBeenCalledWith(saved.cachePath)
      expect(f.create).toHaveBeenCalledWith(saved.cachePath, 'Remote project')
      expect(saved.workspaceId).toBe('workspace-remote-1')

      const persisted = (await new SshProfileStore(f.home).list())[0]
      expect(persisted).toMatchObject({
        id: saved.id,
        name: 'Remote project',
        workspaceId: 'workspace-remote-1',
      })
    } finally {
      f.manager.dispose()
    }
  })

  it('reuses the native workspace for the same cache and reconciles its visible title', async () => {
    const f = await fixture({ existingWorkspace: true })
    try {
      const saved = await f.manager.saveAndCreate(f.input)
      expect(f.create).not.toHaveBeenCalled()
      expect(f.workspace.setTitle).toHaveBeenCalledWith('Remote project')
      expect(saved.workspaceId).toBe('workspace-remote-1')
    } finally {
      f.manager.dispose()
    }
  })

  it('does not expose an unusable native workspace when the initial sync fails', async () => {
    const f = await fixture()
    mocks.syncSshWorkspace.mockRejectedValueOnce(new Error('initial sync unavailable'))
    try {
      await expect(f.manager.saveAndCreate(f.input)).rejects.toThrow('initial sync unavailable')
      expect(f.resolveByPath).not.toHaveBeenCalled()
      expect(f.create).not.toHaveBeenCalled()
      expect((await new SshProfileStore(f.home).list())[0]?.workspaceId).toBeUndefined()
    } finally {
      f.manager.dispose()
    }
  })
})
