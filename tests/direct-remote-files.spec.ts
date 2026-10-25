import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DirectRemoteFiles } from '../src/remote-files.ts'
import type { RemoteHelperSession } from '../src/remote-helper.ts'
import type { SshWorkspaceProfile } from '../src/types.ts'

function profile(): SshWorkspaceProfile {
  return {
    id: 'ssh-00000000-0000-4000-8000-000000000000',
    name: 'Direct', host: 'server.example', port: 22, username: 'user',
    remotePath: '/srv/project', cachePath: 'C:\dsh\remote\root', workspaceMode: 'direct',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`, authMode: 'agent', transportMode: 'builtin',
    helperMode: 'auto', terminalGraceSeconds: 300, portForwards: [], pollIntervalMs: 5_000,
    excludes: ['.git', 'node_modules', '.dsh-conflicts'],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function helper() {
  const exec = vi.fn(async (args: readonly string[], options?: { input?: Buffer | string }) => {
    switch (args[0]) {
      case 'resolve': return { stdout: Buffer.from(JSON.stringify({ path: args[1] })), stderr: Buffer.alloc(0), exitCode: 0 }
      case 'list': return {
        stdout: Buffer.from([
          JSON.stringify({ name: 'src', kind: 'directory', size: 0, mtimeMs: 10, mode: 0o755 }),
          JSON.stringify({ name: 'README.md', kind: 'file', size: 5, mtimeMs: 11, mode: 0o644 }),
        ].join('\n')),
        stderr: Buffer.alloc(0), exitCode: 0,
      }
      case 'stat': return {
        stdout: Buffer.from(JSON.stringify({ stat: { kind: 'file', size: 5, mtimeMs: 11, mode: 0o644 } })),
        stderr: Buffer.alloc(0), exitCode: 0,
      }
      case 'read-head': return { stdout: Buffer.from('hello'), stderr: Buffer.alloc(0), exitCode: 0 }
      case 'read-range': {
        const start = Number(args[2])
        const length = Number(args[3])
        return { stdout: Buffer.from('hello').subarray(start, start + length), stderr: Buffer.alloc(0), exitCode: 0 }
      }
      case 'hash': return { stdout: Buffer.from(JSON.stringify({ hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', size: 5 })), stderr: Buffer.alloc(0), exitCode: 0 }
      case 'write': return {
        stdout: Buffer.from(JSON.stringify({ stat: { kind: 'file', size: Buffer.byteLength(options?.input ?? ''), mtimeMs: 12, mode: 0o644 } })),
        stderr: Buffer.alloc(0), exitCode: 0,
      }
      default: throw new Error(`unexpected helper command ${args.join(' ')}`)
    }
  })

  return { exec, helper: { version: 10 }, sftp: undefined } as unknown as RemoteHelperSession
}

describe('direct remote file access', () => {
  it('lists and reads only requested remote paths while keeping virtual local addresses', async () => {
    const session = helper()
    const files = new DirectRemoteFiles(profile(), session)
    const listing = await files.list(profile().cachePath, 100)
    expect(listing.entries.map(row => [row.name, row.isDir])).toEqual([['src', true], ['README.md', false]])
    expect(listing.entries[1]?.path).toBe(resolve(profile().cachePath, 'README.md'))

    const read = await files.read(resolve(profile().cachePath, 'README.md'), 1024)
    expect(Buffer.from(read.bytes).toString('utf8')).toBe('hello')
    expect(read.revision.token).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect((session.exec as ReturnType<typeof vi.fn>).mock.calls.some(call => call[0]?.[0] === 'scan')).toBe(false)
  })

  it('reads a bounded range without downloading or hashing the complete remote file', async () => {
    const session = helper()
    const files = new DirectRemoteFiles(profile(), session)
    const read = await files.readRange(resolve(profile().cachePath, 'README.md'), 1, 3)
    expect(Buffer.from(read.bytes).toString('utf8')).toBe('ell')
    expect(read.revision.size).toBe(5)
    expect(read.revision.strong).toBe(false)
    expect((session.exec as ReturnType<typeof vi.fn>).mock.calls.some(call => (
      call[0]?.[0] === 'read-range' && call[0]?.[2] === '1' && call[0]?.[3] === '3'
    ))).toBe(true)
  })

  it('writes atomically through the helper and guards the expected content revision', async () => {
    const session = helper()
    const files = new DirectRemoteFiles(profile(), session)
    const revision = await files.write(
      resolve(profile().cachePath, 'README.md'),
      Buffer.from('updated'),
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
    expect(revision.strong).toBe(true)
    expect((session.exec as ReturnType<typeof vi.fn>).mock.calls.some(call => call[0]?.[0] === 'write')).toBe(true)
  })

  it('refuses canonical paths that escape the configured remote root', async () => {
    const session = helper()
    ;(session.exec as ReturnType<typeof vi.fn>).mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'stat') return { stdout: Buffer.from(JSON.stringify({ stat: { kind: 'file', size: 1, mtimeMs: 1, mode: 0o644 } })), stderr: Buffer.alloc(0), exitCode: 0 }
      if (args[0] === 'resolve') return { stdout: Buffer.from(JSON.stringify({ path: '/etc/passwd' })), stderr: Buffer.alloc(0), exitCode: 0 }
      throw new Error('unexpected')
    })
    const files = new DirectRemoteFiles(profile(), session)
    await expect(files.stat(resolve(profile().cachePath, 'escape'))).rejects.toThrow('越出了工作区')
  })
})
