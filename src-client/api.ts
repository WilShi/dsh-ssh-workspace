import type {
  SafeSshProfile,
  OpenSshHostEntry,
  SshDetectedPort,
  SshPortForward,
  SshProbeResult,
  SshProfileInput,
  SshWorkspaceApiResult,
  SshWorkspaceStatus,
} from '../src/types.ts'

export interface SshWorkspaceApi {
  list(): Promise<readonly SafeSshProfile[]>
  probe(input: SshProfileInput): Promise<SshProbeResult>
  save(input: SshProfileInput): Promise<SafeSshProfile>
  sync(id: string, options?: { readonly allowBulkDelete?: boolean }): Promise<SshWorkspaceStatus>
  resolveConflict(id: string, path: string, strategy: 'local' | 'remote'): Promise<SshWorkspaceStatus>
  delete(id: string): Promise<void>
  clearCache(id: string): Promise<number>
  listOpenSshHosts(): Promise<readonly OpenSshHostEntry[]>
  listForwards(): Promise<readonly SshPortForward[]>
  detectPorts(id: string): Promise<readonly SshDetectedPort[]>
  addForward(id: string, remotePort: number, localPort?: number, remoteHost?: string): Promise<SshPortForward>
  restartForward(id: string): Promise<SshPortForward>
  removeForward(id: string): Promise<void>
}

async function request(path: string, body?: unknown): Promise<SshWorkspaceApiResult> {
  const response = await fetch(`/ssh-workspace-api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let result: SshWorkspaceApiResult
  try { result = await response.json() as SshWorkspaceApiResult } catch { throw new Error(`远程工作区服务返回了无效响应（HTTP ${response.status}）`) }
  if (!response.ok || !result.ok) throw new Error(result.message ?? result.code ?? `远程工作区操作失败（HTTP ${response.status}）`)
  return result
}

export function createSshWorkspaceApi(): SshWorkspaceApi {
  return {
    async list() {
      const result = await request('profiles')
      if (!Array.isArray(result.profiles)) throw new Error('远程工作区列表格式无效')
      return result.profiles
    },
    async probe(input) {
      const result = await request('probe', input)
      if (result.probe === undefined) throw new Error('连接测试没有返回主机信息')
      return result.probe
    },
    async save(input) {
      const result = await request('save', input)
      if (result.profile === undefined) throw new Error('远程工作区保存后没有返回配置')
      return result.profile
    },
    async sync(id, options = {}) {
      const result = await request('sync', { id, allowBulkDelete: options.allowBulkDelete === true })
      if (result.sync === undefined) throw new Error('同步没有返回状态')
      return result.sync
    },
    async resolveConflict(id, path, strategy) {
      const result = await request('resolve-conflict', { id, path, strategy })
      if (result.sync === undefined) throw new Error('冲突解决后没有返回同步状态')
      return result.sync
    },
    async delete(id) { await request('delete', { id }) },
    async clearCache(id) {
      const result = await request('clear-cache', { id })
      return result.clearedFiles ?? 0
    },
    async listOpenSshHosts() {
      const result = await request('openssh-hosts')
      return result.openSshHosts ?? []
    },
    async listForwards() {
      const result = await request('forwards')
      return result.forwards ?? []
    },
    async detectPorts(id) {
      const result = await request('detect-ports', { id })
      return result.detectedPorts ?? []
    },
    async addForward(id, remotePort, localPort, remoteHost) {
      const result = await request('add-forward', {
        id,
        remotePort,
        ...(localPort === undefined ? {} : { localPort }),
        ...(remoteHost === undefined ? {} : { remoteHost }),
      })
      const forward = result.forwards?.[0]
      if (forward === undefined) throw new Error('端口转发没有返回状态')
      return forward
    },
    async restartForward(id) {
      const result = await request('restart-forward', { id })
      const forward = result.forwards?.[0]
      if (forward === undefined) throw new Error('端口转发重试没有返回状态')
      return forward
    },
    async removeForward(id) { await request('remove-forward', { id }) },
  }
}
