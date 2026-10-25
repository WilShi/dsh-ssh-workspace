import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ openConnection: vi.fn(), openSftp: vi.fn(), closeSftp: vi.fn() }))
vi.mock('../src/ssh-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ssh-client.ts')>()
  return {
    ...actual,
    openSshConnection: mocks.openConnection,
    openSftp: mocks.openSftp,
    closeSftp: mocks.closeSftp,
  }
})

import { RemoteHelperSession } from '../src/remote-helper.ts'
import { DSH_SSH_HELPER_VERSION } from '../src/remote-helper-source.ts'

class CommandChannel extends EventEmitter {
  readonly stderr = new EventEmitter()

  constructor(private readonly output: Buffer, private readonly code = 0) { super() }
  end(_input?: Buffer | string) {
    queueMicrotask(() => {
      if (this.output.length > 0) this.emit('data', this.output)
      this.emit('close', this.code)
    })
  }
  close() { this.emit('close', null) }
}

afterEach(() => {
  mocks.openConnection.mockReset()
  mocks.openSftp.mockReset()
  mocks.closeSftp.mockReset()
})

describe('versioned remote helper installation', () => {
  it('replaces a corrupt helper probe instead of silently degrading forever', async () => {
    const commands: string[] = []
    const validProbe = Buffer.from(JSON.stringify({
      version: DSH_SSH_HELPER_VERSION, platform: 'linux', hostname: 'server', python: '3.11.0',
      tmux: true, inotifywait: true, ss: true,
    }))
    let call = 0
    const outputs = [Buffer.from('this is not json'), Buffer.from('python3\n'), Buffer.alloc(0), validProbe]
    const client = {
      exec(command: string, callback: (error: Error | undefined, stream: ClientChannel) => void) {
        commands.push(command)
        const output = outputs[call++] ?? validProbe
        callback(undefined, new CommandChannel(output) as unknown as ClientChannel)
      },
    } as unknown as Client
    const dispose = vi.fn()
    mocks.openConnection.mockResolvedValue({ client, fingerprint: `SHA256:${'A'.repeat(43)}`, dispose })
    mocks.openSftp.mockRejectedValue(new Error('SFTP disabled for fixture'))

    const session = await RemoteHelperSession.open({
      id: 'ssh-test', host: 'server', port: 22, username: 'user', authMode: 'agent',
      transportMode: 'builtin', helperMode: 'auto',
    })
    expect(commands).toHaveLength(4)
    expect(commands[2]).toContain('cat >')
    expect(session.capabilities.degradedReason).toBeUndefined()
    expect(session.helper?.version).toBe(DSH_SSH_HELPER_VERSION)
    expect(session.capabilities).toMatchObject({ helper: true, persistentTerminals: true, realtimeFileEvents: true })
    session.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
