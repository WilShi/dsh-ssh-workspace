import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/remote-helper.ts', () => ({ openRemoteHelperSession: mocks.open }))

import { PersistentRemoteTerminal } from '../src/persistent-terminal.ts'
import type { SshWorkspaceProfile } from '../src/types.ts'

function profile(): SshWorkspaceProfile {
  const now = new Date(0).toISOString()
  return {
    id: 'ssh-00000000-0000-4000-8000-000000000003', name: 'server', host: 'server', port: 22,
    username: 'user', remotePath: '/srv', cachePath: 'C:\\cache\\ssh',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`, authMode: 'agent', transportMode: 'builtin',
    helperMode: 'auto', terminalGraceSeconds: 300, portForwards: [], pollIntervalMs: 5_000,
    excludes: ['node_modules'], createdAt: now, updatedAt: now,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function session() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const finished = deferred<{ exitCode: number | null }>()
  const process = { stdout, stderr, stdin: new PassThrough(), close: vi.fn(), wait: vi.fn(() => finished.promise) }
  const exec = vi.fn(async (args: readonly string[]) => ({
    stdout: Buffer.from(args[0] === 'terminal-start' ? JSON.stringify({ offset: 0 }) : ''),
    stderr: Buffer.alloc(0), exitCode: 0,
  }))
  return {
    value: {
      helper: { tmux: true }, exec, spawn: vi.fn(async () => process), dispose: vi.fn(),
    },
    process,
    finished,
    exec,
  }
}

afterEach(() => {
  mocks.open.mockReset()
  vi.useRealTimers()
})

describe('persistent remote terminal', () => {
  it('continues output and de-duplicates queued input across reconnects', async () => {
    vi.useFakeTimers()
    const first = session()
    const second = session()
    mocks.open.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value)
    const terminal = await PersistentRemoteTerminal.open({
      key: 'session:tab', title: 'SSH', sessionId: 'session', tabId: 'tab', cwd: 'C:\\cache\\ssh',
      profile: profile(), remoteCwd: '/srv', cols: 120, rows: 40,
    })
    expect(terminal).toBeDefined()
    first.process.stdout.write('before reconnect\n')
    terminal?.write('echo once\n')
    await vi.advanceTimersByTimeAsync(0)
    const firstInput = first.exec.mock.calls.filter(call => call[0][0] === 'terminal-input')
    expect(firstInput).toHaveLength(1)

    first.finished.resolve({ exitCode: 255 })
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.open).toHaveBeenCalledTimes(2)
    second.process.stdout.write('after reconnect\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(terminal?.transcript).toContain('before reconnect')
    expect(terminal?.transcript).toContain('after reconnect')
    expect(terminal?.exited).toBe(false)

    terminal?.detach()
    await vi.advanceTimersByTimeAsync(0)
    expect(second.exec.mock.calls.some(call => call[0][0] === 'terminal-detach')).toBe(true)
  })
})
