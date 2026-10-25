import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSshWorkspaceRoute } from '../src/api-route.ts'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function serve(manager: Record<string, unknown>): Promise<string> {
  const server = createServer(createSshWorkspaceRoute(manager as never))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('SSH Workspace Host API fence and dispatch', () => {
  it('accepts same-origin renderer requests and never needs a secret for list', async () => {
    const list = vi.fn(async () => [])
    const base = await serve({ list })
    const response = await fetch(`${base}/ssh-workspace-api/profiles`, { headers: { referer: `${base}/` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, profiles: [] })
    expect(list).toHaveBeenCalledOnce()
  })

  it('rejects cross-origin mutation before reading or dispatching the body', async () => {
    const saveAndCreate = vi.fn()
    const base = await serve({ saveAndCreate })
    const response = await fetch(`${base}/ssh-workspace-api/save`, {
      method: 'POST',
      headers: { origin: 'http://attacker.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'must-not-be-read' }),
    })
    expect(response.status).toBe(403)
    expect(saveAndCreate).not.toHaveBeenCalled()
  })

  it('dispatches conflict resolution only for a closed strategy union', async () => {
    const resolveConflict = vi.fn(async () => ({
      profileId: 'ssh-id', phase: 'ready', conflictCount: 0, filesPulled: 0, filesPushed: 0, connected: false, conflicts: [],
    }))
    const base = await serve({ resolveConflict })
    const response = await fetch(`${base}/ssh-workspace-api/resolve-conflict`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ssh-id', path: 'src/a.ts', strategy: 'local' }),
    })
    expect(response.status).toBe(200)
    expect(resolveConflict).toHaveBeenCalledWith('ssh-id', 'src/a.ts', 'local')
  })

  it('requires an explicit boolean before allowing a guarded bulk deletion', async () => {
    const sync = vi.fn(async () => ({
      profileId: 'ssh-id', phase: 'ready', conflictCount: 0, filesPulled: 0, filesPushed: 0, connected: false, conflicts: [],
    }))
    const base = await serve({ sync })
    const response = await fetch(`${base}/ssh-workspace-api/sync`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ssh-id', allowBulkDelete: true }),
    })
    expect(response.status).toBe(200)
    expect(sync).toHaveBeenCalledWith('ssh-id', { allowBulkDelete: true })
  })

  it('dispatches port discovery and lifecycle routes with validated ports', async () => {
    const detectPorts = vi.fn(async () => [{ host: '127.0.0.1', port: 3_000 }])
    const addPortForward = vi.fn(async () => ({
      id: 'forward-1', profileId: 'ssh-id', remoteHost: '127.0.0.1', remotePort: 3_000,
      localHost: '127.0.0.1', localPort: 3_000, createdAt: new Date(0).toISOString(), state: 'ready',
    }))
    const removePortForward = vi.fn(async () => {})
    const restartPortForward = vi.fn(async () => ({
      id: 'forward-2', profileId: 'ssh-id', remoteHost: '127.0.0.1', remotePort: 3_000,
      localHost: '127.0.0.1', localPort: 4_000, createdAt: new Date(0).toISOString(), state: 'ready',
    }))
    const listPortForwards = vi.fn(() => [])
    const base = await serve({ detectPorts, addPortForward, removePortForward, restartPortForward, listPortForwards })
    const headers = { origin: base, 'content-type': 'application/json' }

    const detected = await fetch(`${base}/ssh-workspace-api/detect-ports`, {
      method: 'POST', headers, body: JSON.stringify({ id: 'ssh-id' }),
    })
    expect(detected.status).toBe(200)
    expect(detectPorts).toHaveBeenCalledWith('ssh-id')
    const added = await fetch(`${base}/ssh-workspace-api/add-forward`, {
      method: 'POST', headers, body: JSON.stringify({ id: 'ssh-id', remotePort: 3_000, localPort: 4_000, remoteHost: '127.0.0.1' }),
    })
    expect(added.status).toBe(200)
    expect(addPortForward).toHaveBeenCalledWith('ssh-id', 3_000, 4_000, '127.0.0.1')
    const removed = await fetch(`${base}/ssh-workspace-api/remove-forward`, {
      method: 'POST', headers, body: JSON.stringify({ id: 'forward-1' }),
    })
    expect(removed.status).toBe(200)
    expect(removePortForward).toHaveBeenCalledWith('forward-1')
    const restarted = await fetch(`${base}/ssh-workspace-api/restart-forward`, {
      method: 'POST', headers, body: JSON.stringify({ id: 'forward-1' }),
    })
    expect(restarted.status).toBe(200)
    expect(restartPortForward).toHaveBeenCalledWith('forward-1')

    const invalid = await fetch(`${base}/ssh-workspace-api/add-forward`, {
      method: 'POST', headers, body: JSON.stringify({ id: 'ssh-id', remotePort: 3_000.5 }),
    })
    expect(invalid.status).toBe(400)
    expect(addPortForward).toHaveBeenCalledTimes(1)
  })
})
