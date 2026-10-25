import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SshWorkspaceManager } from './manager.ts'
import { SshConnectionError } from './ssh-client.ts'
import type { SshProfileInput, SshWorkspaceStatus } from './types.ts'
import { SshWorkspaceValidationError } from './validation.ts'
import { listOpenSshHosts } from './system-ssh.ts'

// Cordis prefix routes use the slash-free mount path. A trailing slash here
// fails to match `/ssh-workspace-api/profiles` in the real Web host even
// though a standalone Node HTTP test still reaches the handler directly.
export const SSH_WORKSPACE_API_PREFIX = '/ssh-workspace-api'
const BODY_LIMIT = 2 * 1024 * 1024

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += data.length
    if (total > BODY_LIMIT) throw new SshWorkspaceValidationError('请求内容过大')
    chunks.push(data)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try { return JSON.parse(text) as unknown } catch { throw new SshWorkspaceValidationError('请求不是有效 JSON') }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SshWorkspaceValidationError('请求格式无效')
  return value as Record<string, unknown>
}

/** Credential-changing routes are accepted only from the loaded same-origin renderer. */
export function isTrustedSshWorkspaceRequest(request: IncomingMessage): boolean {
  const host = String(request.headers.host ?? '').toLowerCase()
  const address = request.socket.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback || host === '') return false
  const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (fetchSite === 'same-origin') return true
  const origin = request.headers.origin
  if (typeof origin === 'string') {
    try { return new URL(origin).host.toLowerCase() === host } catch { return false }
  }
  if ((request.method ?? 'GET').toUpperCase() !== 'GET') return false
  const referer = request.headers.referer
  if (typeof referer !== 'string') return false
  try { return new URL(referer).host.toLowerCase() === host } catch { return false }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

function routePath(request: IncomingMessage): string {
  const pathname = new URL(request.url ?? SSH_WORKSPACE_API_PREFIX, 'http://dsh.internal').pathname
  return pathname.slice(SSH_WORKSPACE_API_PREFIX.length).replace(/^\/+|\/+$/gu, '')
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof SshWorkspaceValidationError) return { code: error.code, message: error.message }
  if (error instanceof SshConnectionError) return { code: error.code, message: error.message }
  return { code: 'INTERNAL', message: '远程工作区操作失败，请稍后重试并查看诊断日志。' }
}

export function createSshWorkspaceRoute(manager: SshWorkspaceManager) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isTrustedSshWorkspaceRequest(request)) { send(response, 403, { ok: false, code: 'FORBIDDEN', message: '请求来源不受信任' }); return }
    const method = (request.method ?? 'GET').toUpperCase()
    const path = routePath(request)
    if (method === 'POST' && !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      send(response, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: '请求必须使用 application/json' })
      return
    }
    try {
      if (method === 'GET' && (path === '' || path === 'profiles')) {
        send(response, 200, { ok: true, profiles: await manager.list() })
        return
      }
      if (method === 'GET' && path === 'openssh-hosts') {
        send(response, 200, { ok: true, openSshHosts: await listOpenSshHosts() })
        return
      }
      if (method === 'GET' && path === 'forwards') {
        send(response, 200, { ok: true, forwards: manager.listPortForwards() })
        return
      }
      if (method !== 'POST') { send(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }); return }
      const body = objectBody(await readJson(request))
      if (path === 'probe') {
        send(response, 200, { ok: true, probe: await manager.probe(body as unknown as SshProfileInput) })
      } else if (path === 'save') {
        send(response, 200, { ok: true, profile: await manager.saveAndCreate(body as unknown as SshProfileInput) })
      } else if (path === 'sync') {
        if (typeof body.id !== 'string') throw new SshWorkspaceValidationError('缺少连接 ID')
        const sync: SshWorkspaceStatus = await manager.sync(body.id, {
          allowBulkDelete: body.allowBulkDelete === true,
        })
        send(response, sync.phase === 'error' ? 409 : 200, { ok: sync.phase !== 'error', sync, ...(sync.lastError === undefined ? {} : { message: sync.lastError }) })
      } else if (path === 'delete') {
        if (typeof body.id !== 'string') throw new SshWorkspaceValidationError('缺少连接 ID')
        await manager.delete(body.id)
        send(response, 200, { ok: true })
      } else if (path === 'clear-cache') {
        if (typeof body.id !== 'string') throw new SshWorkspaceValidationError('缺少连接 ID')
        send(response, 200, { ok: true, clearedFiles: await manager.clearDirectCache(body.id) })
      } else if (path === 'resolve-conflict') {
        if (typeof body.id !== 'string' || typeof body.path !== 'string'
          || (body.strategy !== 'local' && body.strategy !== 'remote')) throw new SshWorkspaceValidationError('冲突解决请求无效')
        const sync = await manager.resolveConflict(body.id, body.path, body.strategy)
        send(response, 200, { ok: true, sync })
      } else if (path === 'detect-ports') {
        if (typeof body.id !== 'string') throw new SshWorkspaceValidationError('缺少连接 ID')
        send(response, 200, { ok: true, detectedPorts: await manager.detectPorts(body.id) })
      } else if (path === 'add-forward') {
        if (typeof body.id !== 'string' || !Number.isInteger(body.remotePort)) {
          throw new SshWorkspaceValidationError('端口转发请求无效')
        }
        const forward = await manager.addPortForward(
          body.id,
          Number(body.remotePort),
          body.localPort === undefined ? undefined : Number(body.localPort),
          typeof body.remoteHost === 'string' ? body.remoteHost : undefined,
        )
        send(response, 200, { ok: true, forwards: [forward] })
      } else if (path === 'remove-forward') {
        if (typeof body.id !== 'string') throw new SshWorkspaceValidationError('缺少转发 ID')
        await manager.removePortForward(body.id)
        send(response, 200, { ok: true })
      } else if (path === 'restart-forward') {
        if (typeof body.id !== 'string') throw new SshWorkspaceValidationError('缺少转发 ID')
        send(response, 200, { ok: true, forwards: [await manager.restartPortForward(body.id)] })
      } else {
        send(response, 404, { ok: false, code: 'NOT_FOUND' })
      }
    } catch (error) {
      const info = publicError(error)
      if (info.code === 'INTERNAL') process.stderr.write(`[dsh-ssh-workspace] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      send(response, info.code === 'INTERNAL' ? 500 : 400, { ok: false, ...info })
    }
  }
}
