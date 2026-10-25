import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSshWorkspaceApi } from './api.ts'
import { SshWorkspaceCreateFlow } from './SshWorkspaceDialog.tsx'
import { SshWorkspaceView } from './SshWorkspaceView.tsx'

export interface RemoteWorkspaceFlowOwnerProps {
  open: boolean
  busy: boolean
  onCreated: (workspaceId: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.hero.workspace.remoteFlow': {
      kind: 'single'
      scope: 'root'
      owner: RemoteWorkspaceFlowOwnerProps
    }
    'sidebar.workspaces.remoteFlow': {
      kind: 'single'
      scope: 'root'
      owner: RemoteWorkspaceFlowOwnerProps
    }
  }
}

export const name = 'dsh-ssh-workspace'
export const inject = ['slots']

export function apply(ctx: Context): void {
  const api = createSshWorkspaceApi()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ssh-workspaces',
    order: 45,
    label: () => '远程工作区',
    inject: () => ({ api }),
  }, SshWorkspaceView))
  const injected = () => ({ api })
  ctx.slots.inject('conversation.hero.workspace.remoteFlow', () => (
    ctx.slots.inject('sidebar.workspaces.remoteFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.remoteFlow',
        inject: injected,
      }, SshWorkspaceCreateFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.remoteFlow',
        inject: injected,
      }, SshWorkspaceCreateFlow)
    })
  ))
}

export default { name, inject, apply }
