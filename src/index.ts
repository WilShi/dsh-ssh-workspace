import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { createSshWorkspaceRoute, SSH_WORKSPACE_API_PREFIX } from './api-route.ts'
import { SshWorkspaceManager, type RemoteTerminalHandle } from './manager.ts'
import { createSshWorkspaceTools } from './tools.ts'

export * from './types.ts'
export { createSshWorkspaceRoute, isTrustedSshWorkspaceRequest, SSH_WORKSPACE_API_PREFIX } from './api-route.ts'
export { SshWorkspaceManager } from './manager.ts'
export type { RemoteTerminalHandle, SshWorkspaceService } from './manager.ts'

export const name = 'dsh-ssh-workspace'
export const inject = ['webServer', 'credentials', 'workspaceRegistry', 'tools']

interface WebServerFace {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler(request: IncomingMessage, response: ServerResponse): Promise<void> | void
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServerFace
    credentials: CredentialProvider
    workspaceRegistry: WorkspaceRegistry
    tools: ToolRuntime
    sshWorkspace: SshWorkspaceRuntime
  }
}

/** Cordis service consumed dynamically by the side-card terminal. */
export class SshWorkspaceRuntime extends Service {
  constructor(ctx: Context, readonly manager: SshWorkspaceManager) {
    super(ctx, 'sshWorkspace')
  }

  findByCachePath(cwd: string) { return this.manager.findByCachePath(cwd) }
  findDirectByCachePath(cwd: string) { return this.manager.findDirectByCachePath(cwd) }
  listRemoteDirectory(cwd: string, path: string, maximumEntries: number) { return this.manager.listRemoteDirectory(cwd, path, maximumEntries) }
  searchRemoteFiles(cwd: string, query: string, maximumEntries: number) { return this.manager.searchRemoteFiles(cwd, query, maximumEntries) }
  statRemoteFile(cwd: string, path: string) { return this.manager.statRemoteFile(cwd, path) }
  readRemoteFile(cwd: string, path: string, maximumBytes: number, signal?: AbortSignal) {
    return this.manager.readRemoteFile(cwd, path, maximumBytes, signal)
  }
  readRemoteRange(cwd: string, path: string, start: number, length: number, signal?: AbortSignal) {
    return this.manager.readRemoteRange(cwd, path, start, length, signal)
  }
  writeRemoteFile(cwd: string, path: string, bytes: Uint8Array, expectedRevision?: string) {
    return this.manager.writeRemoteFile(cwd, path, bytes, expectedRevision)
  }
  createRemoteDirectory(cwd: string, path: string) { return this.manager.createRemoteDirectory(cwd, path) }
  removeRemotePath(cwd: string, path: string, recursive?: boolean) { return this.manager.removeRemotePath(cwd, path, recursive) }
  renameRemotePath(cwd: string, from: string, to: string) { return this.manager.renameRemotePath(cwd, from, to) }
  remoteChangesForCachePath(cwd: string) { return this.manager.remoteChangesForCachePath(cwd) }
  executeForCachePath(cwd: string, command: string, signal?: AbortSignal) { return this.manager.executeForCachePath(cwd, command, signal) }
  async syncForCachePath(cwd: string) {
    const profile = await this.manager.findByCachePath(cwd)
    if (profile === undefined) return undefined
    return await this.manager.sync(profile.id)
  }
  openTerminal(sessionId: string, tabId: string, cwd: string, cols: number, rows: number): Promise<RemoteTerminalHandle | undefined> {
    return this.manager.openTerminal(sessionId, tabId, cwd, cols, rows)
  }
  scheduleTerminalClose(key: string, delayMs: number): void { this.manager.scheduleTerminalClose(key, delayMs) }
  closeTerminal(key: string): void { this.manager.closeTerminal(key) }
}

export async function apply(ctx: Context): Promise<void> {
  const manager = new SshWorkspaceManager(ctx.credentials, ctx.workspaceRegistry, undefined, message => ctx.logger.warn(message))
  const runtime = new SshWorkspaceRuntime(ctx, manager)
  await manager.bootstrap()
  ctx.effect(() => () => manager.dispose(), 'dsh-ssh-workspace: dispose manager')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: SSH_WORKSPACE_API_PREFIX,
    handler: createSshWorkspaceRoute(manager),
  }), 'dsh-ssh-workspace: configuration API')
  ctx.effect(() => {
    const disposers = createSshWorkspaceTools(manager).map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'dsh-ssh-workspace: model tools')
  void runtime
}

export default { name, inject, apply }
