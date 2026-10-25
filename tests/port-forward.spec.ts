import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Client } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn(), tunnel: vi.fn() }))
vi.mock('../src/ssh-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ssh-client.ts')>()
  return { ...actual, openSshConnection: mocks.open }
})
vi.mock('../src/system-ssh.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/system-ssh.ts')>()
  return { ...actual, spawnSystemSshTunnel: mocks.tunnel }
})

import { openPortForward } from '../src/port-forward.ts'
import type { SshWorkspaceProfile } from '../src/types.ts'

function profile(system: boolean): SshWorkspaceProfile {
  const now = new Date(0).toISOString()
  return {
    id: 'ssh-00000000-0000-4000-8000-000000000004', name: 'server', host: 'server', port: 22,
    username: 'user', remotePath: '/srv', cachePath: 'C:\\cache\\ssh',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`, authMode: system ? 'openssh-config' : 'agent',
    transportMode: system ? 'system' : 'builtin', ...(system ? { openSshHost: 'server' } : {}),
    helperMode: 'auto', terminalGraceSeconds: 300, portForwards: [], pollIntervalMs: 5_000,
    excludes: ['node_modules'], createdAt: now, updatedAt: now,
  }
}

function childProcess() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) })
  return child
}

afterEach(() => {
  mocks.open.mockReset()
  mocks.tunnel.mockReset()
})

describe('managed SSH port forwarding', () => {
  it('marks a system tunnel unhealthy when OpenSSH exits after startup', async () => {
    const child = childProcess()
    mocks.tunnel.mockResolvedValue(child)
    const forward = await openPortForward(profile(true), undefined, { remotePort: 3_000, localPort: 0 })
    expect(forward.value).toMatchObject({ remotePort: 3_000, state: 'ready' })
    expect(forward.value.localPort).toBeGreaterThan(0)
    child.emit('exit', 255, null)
    expect(forward.value.state).toBe('error')
    expect(forward.value.lastError).toContain('255')
    await forward.close()
    expect(forward.value.state).toBe('stopped')
  })

  it('marks a built-in tunnel unhealthy when its pooled SSH transport closes', async () => {
    const client = new EventEmitter() as Client
    Object.assign(client, { forwardOut: vi.fn() })
    const dispose = vi.fn()
    mocks.open.mockResolvedValue({ client, fingerprint: `SHA256:${'A'.repeat(43)}`, dispose })
    const forward = await openPortForward(profile(false), undefined, { remotePort: 8_080, localPort: 0 })
    expect(forward.value.state).toBe('ready')
    client.emit('close')
    expect(forward.value).toMatchObject({ state: 'error', lastError: 'SSH 连接已断开' })
    await forward.close()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
