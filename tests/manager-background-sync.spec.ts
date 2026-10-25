import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshWorkspaceManager } from '../src/manager.ts'
import type { SshWorkspaceProfile, SshWorkspaceStatus } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true })
})

function status(profileId: string): SshWorkspaceStatus {
  return {
    profileId,
    phase: 'ready',
    conflictCount: 0,
    filesPulled: 0,
    filesPushed: 0,
    connected: false,
    availability: 'live',
    conflicts: [],
  }
}

describe('SSH background sync scheduling', () => {
  it('replaces the interval when an edited profile changes its polling period', async () => {
    vi.useFakeTimers()
    const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-background-'))
    roots.push(home)
    const manager = new SshWorkspaceManager(
      {} as CredentialProvider,
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
      authMode: 'agent',
      transportMode: 'auto', helperMode: 'auto', terminalGraceSeconds: 300,
      portForwards: [],
      pollIntervalMs: 5_000,
      excludes: ['.git', 'node_modules'],
      createdAt: now,
      updatedAt: now,
    }
    await manager.profiles.put(profile)
    const sync = vi.spyOn(manager, 'sync').mockResolvedValue(status(id))
    const ensureBackgroundSync = manager as unknown as {
      ensureBackgroundSync(id: string, options?: { resetInterval?: boolean; syncNow?: boolean }): Promise<void>
    }

    await ensureBackgroundSync.ensureBackgroundSync(id, { syncNow: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).toHaveBeenCalledTimes(1)

    await manager.profiles.put({ ...profile, pollIntervalMs: 60_000, updatedAt: new Date().toISOString() })
    await ensureBackgroundSync.ensureBackgroundSync(id, { resetInterval: true, syncNow: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(55_000)
    expect(sync).toHaveBeenCalledTimes(2)
    manager.dispose()
  })

  it('backs off repeated background failures instead of retrying every polling tick', async () => {
    vi.useFakeTimers()
    const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-background-'))
    roots.push(home)
    const manager = new SshWorkspaceManager(
      {} as CredentialProvider,
      {} as Pick<WorkspaceRegistry, 'create' | 'resolveByPath' | 'delete'>,
      home,
    )
    const id = manager.profiles.newId()
    const now = new Date().toISOString()
    await manager.profiles.put({
      id,
      name: 'remote',
      host: 'server.example',
      port: 22,
      username: 'user',
      remotePath: '/srv/project',
      cachePath: manager.profiles.cachePath(id),
      hostFingerprint: `SHA256:${'A'.repeat(43)}`,
      authMode: 'agent',
      transportMode: 'auto', helperMode: 'auto', terminalGraceSeconds: 300,
      portForwards: [],
      pollIntervalMs: 5_000,
      excludes: ['.git', 'node_modules'],
      createdAt: now,
      updatedAt: now,
    })
    const sync = vi.spyOn(manager, 'sync').mockResolvedValue({
      ...status(id), phase: 'error', lastError: 'offline',
    })
    const ensureBackgroundSync = manager as unknown as {
      ensureBackgroundSync(id: string, options?: { resetInterval?: boolean; syncNow?: boolean }): Promise<void>
    }

    await ensureBackgroundSync.ensureBackgroundSync(id, { syncNow: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).toHaveBeenCalledTimes(2)
    manager.dispose()
  })
})
