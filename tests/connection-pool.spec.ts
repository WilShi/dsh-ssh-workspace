import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('../src/ssh-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ssh-client.ts')>()
  return { ...actual, openSshConnection: mocks.open }
})

import { SshConnectionPool } from '../src/connection-pool.ts'
import type { SshWorkspaceProfile } from '../src/types.ts'

function profile(): SshWorkspaceProfile {
  const now = new Date(0).toISOString()
  return {
    id: 'ssh-00000000-0000-4000-8000-000000000001', name: 'server', host: 'server.internal', port: 22,
    username: 'user', remotePath: '/srv', cachePath: 'C:\\cache\\ssh',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`, authMode: 'agent', transportMode: 'builtin',
    helperMode: 'auto', terminalGraceSeconds: 300, portForwards: [], pollIntervalMs: 5_000,
    excludes: ['.git'], createdAt: now, updatedAt: now,
  }
}

function connection() {
  const client = new EventEmitter() as Client
  const dispose = vi.fn()
  return { client, fingerprint: `SHA256:${'A'.repeat(43)}`, dispose }
}

afterEach(() => {
  mocks.open.mockReset()
  vi.useRealTimers()
})

describe('authenticated SSH connection pool', () => {
  it('reuses one transport and closes it only after the final idle lease', async () => {
    vi.useFakeTimers()
    const opened = connection()
    mocks.open.mockResolvedValue(opened)
    const pool = new SshConnectionPool(1_000)

    const first = await pool.acquire(profile())
    const second = await pool.acquire(profile())
    expect(mocks.open).toHaveBeenCalledOnce()
    first.release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(opened.dispose).not.toHaveBeenCalled()
    second.release()
    await vi.advanceTimersByTimeAsync(999)
    expect(opened.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(opened.dispose).toHaveBeenCalledOnce()
  })

  it('invalidates a changed profile and never reuses a closed connection', async () => {
    const first = connection()
    const second = connection()
    mocks.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const pool = new SshConnectionPool()
    const lease = await pool.acquire(profile())
    pool.invalidate(profile().id)
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())
    lease.release()
    const replacement = await pool.acquire(profile())
    expect(replacement.connection).toBe(second)
    expect(mocks.open).toHaveBeenCalledTimes(2)
    replacement.release()
    pool.dispose()
  })
})
