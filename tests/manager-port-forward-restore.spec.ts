import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/port-forward.ts', () => ({ openPortForward: mocks.open }))

import { SshWorkspaceManager } from '../src/manager.ts'
import type { SshWorkspaceProfile } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  mocks.open.mockReset()
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true })
})

describe('saved port-forward restoration', () => {
  it('retains a saved tunnel after a temporary startup failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-forward-restore-'))
    roots.push(home)
    const manager = new SshWorkspaceManager(
      { readRecord: vi.fn(async () => undefined) } as unknown as CredentialProvider,
      {} as Pick<WorkspaceRegistry, 'create' | 'resolveByPath' | 'delete'>,
      home,
    )
    const id = manager.profiles.newId()
    const now = new Date(0).toISOString()
    const profile: SshWorkspaceProfile = {
      id, name: 'server', host: 'server', port: 22, username: 'user', remotePath: '/srv',
      cachePath: manager.profiles.cachePath(id), hostFingerprint: `SHA256:${'A'.repeat(43)}`,
      authMode: 'openssh-config', transportMode: 'system', openSshHost: 'server', helperMode: 'auto',
      terminalGraceSeconds: 300,
      portForwards: [{ remoteHost: '127.0.0.1', remotePort: 3_000, localHost: '127.0.0.1', localPort: 3_000 }],
      pollIntervalMs: 5_000, excludes: ['node_modules'], createdAt: now, updatedAt: now,
    }
    await manager.profiles.put(profile)
    mocks.open.mockRejectedValue(new Error('server temporarily unavailable'))
    Object.assign(manager, { ensureBackgroundSync: vi.fn(async () => {}) })

    await manager.bootstrap()
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
    await vi.waitFor(async () => expect((await manager.profiles.get(id))?.portForwards).toEqual(profile.portForwards))
    await vi.waitFor(() => expect(manager.listPortForwards(id)).toEqual([
      expect.objectContaining({ profileId: id, remotePort: 3_000, state: 'error', lastError: 'server temporarily unavailable' }),
    ]))
    manager.dispose()
  })

  it('keeps a retryable saved rule when restarting an unhealthy tunnel still fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-forward-restart-'))
    roots.push(home)
    const manager = new SshWorkspaceManager(
      { readRecord: vi.fn(async () => undefined) } as unknown as CredentialProvider,
      {} as Pick<WorkspaceRegistry, 'create' | 'resolveByPath' | 'delete'>,
      home,
    )
    const id = manager.profiles.newId()
    const now = new Date(0).toISOString()
    const profile: SshWorkspaceProfile = {
      id, name: 'server', host: 'server', port: 22, username: 'user', remotePath: '/srv',
      cachePath: manager.profiles.cachePath(id), hostFingerprint: `SHA256:${'A'.repeat(43)}`,
      authMode: 'openssh-config', transportMode: 'system', openSshHost: 'server', helperMode: 'auto',
      terminalGraceSeconds: 300,
      portForwards: [{ remoteHost: '127.0.0.1', remotePort: 8_080, localHost: '127.0.0.1', localPort: 8_080 }],
      pollIntervalMs: 5_000, excludes: ['node_modules'], createdAt: now, updatedAt: now,
    }
    await manager.profiles.put(profile)
    const close = vi.fn(async () => {})
    mocks.open.mockResolvedValueOnce({
      value: {
        id: 'forward-existing', profileId: id, remoteHost: '127.0.0.1', remotePort: 8_080,
        localHost: '127.0.0.1', localPort: 8_080, createdAt: now, state: 'ready',
      },
      close,
    })
    Object.assign(manager, { ensureBackgroundSync: vi.fn(async () => {}) })
    await manager.bootstrap()
    await vi.waitFor(() => expect(manager.listPortForwards(id)).toHaveLength(1))

    mocks.open.mockRejectedValueOnce(new Error('server still offline'))
    await expect(manager.restartPortForward('forward-existing')).rejects.toThrow('端口转发重试失败')
    expect(close).toHaveBeenCalledOnce()
    expect(manager.listPortForwards(id)).toEqual([
      expect.objectContaining({ id: 'forward-existing', state: 'error', lastError: 'server still offline' }),
    ])
    expect((await manager.profiles.get(id))?.portForwards).toEqual(profile.portForwards)
    manager.dispose()
  })
})
