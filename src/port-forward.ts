import { createServer, type Server, type Socket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { connectionSpec, openSshConnection, type SshConnection } from './ssh-client.ts'
import { spawnSystemSshTunnel } from './system-ssh.ts'
import type { SshCredentialPayload, SshPortForward, SshWorkspaceProfile } from './types.ts'

interface PortForwardOptions {
  readonly remoteHost?: string
  readonly remotePort: number
  readonly localHost?: string
  readonly localPort?: number
}

export interface ManagedPortForward {
  readonly value: SshPortForward
  close(): Promise<void>
}

function validPort(value: number, allowZero = false): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65_535) throw new Error('端口必须在 1 到 65535 之间')
  return value
}

async function reservePort(host: string, preferred: number): Promise<number> {
  const candidates = preferred === 0
    ? [0]
    : Array.from({ length: 101 }, (_, index) => preferred + index).filter(port => port <= 65_535)
  for (const port of candidates) {
    const server = createServer()
    try {
      const selected = await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host, port, exclusive: true }, () => {
          const address = server.address()
          resolve(typeof address === 'object' && address !== null ? address.port : port)
        })
      })
      await new Promise<void>(resolve => server.close(() => resolve()))
      return selected
    } catch {
      try { server.close() } catch { /* not listening */ }
    }
  }
  throw new Error('没有找到可用的本地转发端口')
}

class BuiltinPortForward implements ManagedPortForward {
  value: SshPortForward

  constructor(
    value: SshPortForward,
    private readonly server: Server,
    private readonly connection: SshConnection,
  ) {
    this.value = value
    server.once('error', error => {
      if (this.value.state !== 'stopped') this.value = { ...this.value, state: 'error', lastError: error.message }
    })
    connection.client.once('close', () => {
      if (this.value.state !== 'stopped') this.value = { ...this.value, state: 'error', lastError: 'SSH 连接已断开' }
    })
    connection.client.once('error', (error: Error) => {
      if (this.value.state !== 'stopped') this.value = { ...this.value, state: 'error', lastError: error.message }
    })
  }

  async close(): Promise<void> {
    this.value = { ...this.value, state: 'stopped' }
    await new Promise<void>(resolve => this.server.close(() => resolve())).catch(() => {})
    this.connection.dispose()
  }
}

class SystemPortForward implements ManagedPortForward {
  value: SshPortForward

  constructor(value: SshPortForward, private readonly child: ChildProcessWithoutNullStreams) {
    this.value = value
    child.once('error', error => {
      if (this.value.state !== 'stopped') this.value = { ...this.value, state: 'error', lastError: error.message }
    })
    child.once('exit', (code, signal) => {
      if (this.value.state === 'stopped') return
      this.value = {
        ...this.value,
        state: 'error',
        lastError: `系统 OpenSSH 转发已退出（${signal ?? String(code)}）`,
      }
    })
  }

  async close(): Promise<void> {
    this.value = { ...this.value, state: 'stopped' }
    this.child.kill()
  }
}

export async function openPortForward(
  profile: SshWorkspaceProfile,
  credential: SshCredentialPayload | undefined,
  options: PortForwardOptions,
): Promise<ManagedPortForward> {
  const remoteHost = options.remoteHost ?? '127.0.0.1'
  const remotePort = validPort(options.remotePort)
  const localHost = options.localHost ?? '127.0.0.1'
  const requestedLocalPort = validPort(options.localPort ?? remotePort, true)
  const system = profile.transportMode === 'system' || profile.authMode === 'openssh-config' || profile.openSshHost !== undefined
  const id = `forward-${randomUUID()}`
  const createdAt = new Date().toISOString()
  if (system) {
    const localPort = await reservePort(localHost, requestedLocalPort)
    const child = await spawnSystemSshTunnel(profile, localHost, localPort, remoteHost, remotePort)
    const diagnostics: Buffer[] = []
    child.stderr.on('data', chunk => {
      if (Buffer.concat(diagnostics).length < 64 * 1024) diagnostics.push(Buffer.from(chunk))
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 750)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(Buffer.concat(diagnostics).toString('utf8').trim() || `系统 OpenSSH 转发退出：${String(code)}`))
      })
    })
    return new SystemPortForward({
      id, profileId: profile.id, remoteHost, remotePort, localHost, localPort, createdAt, state: 'ready',
    }, child)
  }

  const connection = await openSshConnection(connectionSpec(profile, credential))
  const server = createServer((socket: Socket) => {
    connection.client.forwardOut(socket.localAddress ?? localHost, socket.localPort ?? 0, remoteHost, remotePort, (error, stream) => {
      if (error !== undefined) { socket.destroy(error); return }
      socket.pipe(stream).pipe(socket)
      stream.once('error', (streamError: Error) => socket.destroy(streamError))
      socket.once('error', () => stream.close())
    })
  })
  try {
    const localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: localHost, port: requestedLocalPort, exclusive: true }, () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : requestedLocalPort)
      })
    })
    return new BuiltinPortForward({
      id, profileId: profile.id, remoteHost, remotePort, localHost, localPort, createdAt, state: 'ready',
    }, server, connection)
  } catch (error) {
    connection.dispose()
    try { server.close() } catch { /* not listening */ }
    throw error
  }
}
