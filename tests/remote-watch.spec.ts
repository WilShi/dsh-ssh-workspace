import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/remote-helper.ts', () => ({ openRemoteHelperSession: mocks.open }))

import { startRemoteFileWatch } from '../src/remote-watch.ts'
import type { SshWorkspaceProfile } from '../src/types.ts'

function profile(): SshWorkspaceProfile {
  const now = new Date(0).toISOString()
  return {
    id: 'ssh-00000000-0000-4000-8000-000000000002', name: 'server', host: 'server', port: 22,
    username: 'user', remotePath: '/srv', cachePath: 'C:\\cache\\ssh',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`, authMode: 'agent', transportMode: 'builtin',
    helperMode: 'auto', terminalGraceSeconds: 300, portForwards: [], pollIntervalMs: 5_000,
    excludes: ['node_modules'], createdAt: now, updatedAt: now,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function session() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const finished = deferred<{ exitCode: number | null }>()
  const process = { stdout, stderr, stdin: new PassThrough(), close: vi.fn(), wait: vi.fn(() => finished.promise) }
  const dispose = vi.fn()
  return {
    value: {
      helper: { version: 4 },
      capabilities: {
        transport: 'builtin', sftp: true, helper: true, helperVersion: 4,
        realtimeFileEvents: true, persistentTerminals: true, portDiscovery: true,
        portForwarding: true, proxyJump: false, keyboardInteractive: false,
      },
      spawn: vi.fn(async () => process), dispose,
    },
    process,
    finished,
    dispose,
  }
}

afterEach(() => {
  mocks.open.mockReset()
  vi.useRealTimers()
})

describe('reconnecting remote file watcher', () => {
  it('streams changes, ignores malformed events, and reconnects with backoff', async () => {
    vi.useFakeTimers()
    const first = session()
    const second = session()
    mocks.open.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value)
    const onChange = vi.fn()
    const onCapabilities = vi.fn()
    const watcher = startRemoteFileWatch(profile(), undefined, { onChange, onCapabilities })
    expect(watcher).toBeDefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(first.value.spawn).toHaveBeenCalledOnce()

    first.process.stdout.write('not-json\n{"type":"ready","backend":"inotify"}\n')
    first.process.stdout.write('{"type":"change","path":"src/index.ts"}\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(onChange).toHaveBeenCalledWith('src/index.ts')
    expect(onCapabilities).toHaveBeenCalledOnce()

    first.finished.resolve({ exitCode: 255 })
    await vi.advanceTimersByTimeAsync(999)
    expect(mocks.open).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.open).toHaveBeenCalledTimes(2)
    second.process.stdout.write('{"type":"change"}\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(onChange).toHaveBeenLastCalledWith(undefined)

    watcher?.close()
    expect(second.process.close).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
  })
})
