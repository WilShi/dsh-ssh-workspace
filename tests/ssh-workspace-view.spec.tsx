// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshWorkspaceView } from '../src-client/SshWorkspaceView.tsx'
import { SshWorkspaceCreateFlow } from '../src-client/SshWorkspaceDialog.tsx'
import type { SshWorkspaceApi } from '../src-client/api.ts'
import type { SafeSshProfile } from '../src/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Modal: ({ open, title, description, children, footer }: {
    open: boolean; title: string; description?: string; children?: React.ReactNode; footer?: React.ReactNode
  }) => open ? <div role="dialog" aria-label={title}>{description === undefined ? null : <p>{description}</p>}{children}{footer}</div> : null,
}))

const fingerprint = `SHA256:${'A'.repeat(43)}`
const profile: SafeSshProfile = {
  id: 'ssh-00000000-0000-4000-8000-000000000000', name: '研发服务器', host: '10.0.0.1', port: 22,
  username: 'developer', remotePath: '/home/developer/project', cachePath: 'C:\\cache\\ssh',
  hostFingerprint: fingerprint, authMode: 'password', transportMode: 'auto', helperMode: 'auto', terminalGraceSeconds: 300, portForwards: [], pollIntervalMs: 5_000,
  excludes: ['.git', 'node_modules', '.dsh-conflicts'], workspaceId: 'workspace-1',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), credentialConfigured: true,
  status: { profileId: 'ssh-00000000-0000-4000-8000-000000000000', phase: 'ready', conflictCount: 0, filesPulled: 0, filesPushed: 0, connected: false, availability: 'live', conflicts: [] },
}

function api(overrides: Partial<SshWorkspaceApi> = {}): SshWorkspaceApi {
  return {
    list: vi.fn(async () => [profile]),
    probe: vi.fn(async () => ({
      ok: true,
      fingerprint,
      remotePath: '/srv/project',
      remoteRealPath: '/srv/project',
      capabilities: {
        transport: 'builtin', sftp: true, helper: true, helperVersion: 2,
        realtimeFileEvents: false, persistentTerminals: false, portDiscovery: true,
        portForwarding: true, proxyJump: false, keyboardInteractive: false,
      },
    })),
    save: vi.fn(async () => profile),
    sync: vi.fn(async () => profile.status),
    resolveConflict: vi.fn(async () => profile.status),
    delete: vi.fn(async () => {}),
    listOpenSshHosts: vi.fn(async () => []),
    listForwards: vi.fn(async () => []),
    detectPorts: vi.fn(async () => []),
    addForward: vi.fn(async () => ({
      id: 'forward-1', profileId: profile.id, remoteHost: '127.0.0.1', remotePort: 3000,
      localHost: '127.0.0.1', localPort: 3000, createdAt: new Date(0).toISOString(), state: 'ready',
    })),
    restartForward: vi.fn(async () => ({
      id: 'forward-2', profileId: profile.id, remoteHost: '127.0.0.1', remotePort: 3000,
      localHost: '127.0.0.1', localPort: 3000, createdAt: new Date(0).toISOString(), state: 'ready',
    })),
    removeForward: vi.fn(async () => {}),
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('remote Workspace settings page', () => {
  it('renders saved workspaces and completes the test-then-save flow', async () => {
    const service = api()
    render(<SshWorkspaceView api={service} />)
    expect(await screen.findByText('研发服务器')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '添加远程工作区' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '测试机' } })
    fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: '10.0.0.2' } })
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('服务器目录'), { target: { value: '/srv/project' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'runtime-only-secret' } })
    const save = screen.getByRole('button', { name: '创建工作区' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText(/连接成功，主机指纹/u)).toBeTruthy()
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(service.save).toHaveBeenCalledWith(expect.objectContaining({
      name: '测试机', host: '10.0.0.2', username: 'user', remotePath: '/srv/project', hostFingerprint: fingerprint,
    })))
  })

  it('exposes explicit local/remote conflict decisions', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const conflicted: SafeSshProfile = {
      ...profile,
      status: {
        ...profile.status,
        phase: 'conflict', conflictCount: 1,
        conflicts: [{ path: 'src/index.ts', remoteDeleted: false, copyPath: '.dsh-conflicts/src/index.ts.remote', detectedAt: new Date().toISOString() }],
      },
    }
    const service = api({ list: vi.fn(async () => [conflicted]) })
    render(<SshWorkspaceView api={service} />)
    expect(await screen.findByText('src/index.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '用本地版本' }))
    await waitFor(() => expect(service.resolveConflict).toHaveBeenCalledWith(conflicted.id, 'src/index.ts', 'local'))
  })

  it('shows a deliberate confirmation action when bulk deletion protection pauses sync', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const guarded: SafeSshProfile = {
      ...profile,
      status: {
        ...profile.status,
        phase: 'error',
        lastError: '检测到 120 个文件可能被批量删除；请确认后再继续同步',
        deletionGuard: { candidateCount: 120, trackedCount: 200 },
      },
    }
    const service = api({ list: vi.fn(async () => [guarded]) })
    render(<SshWorkspaceView api={service} />)
    expect(await screen.findByText('批量删除保护已暂停同步')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认删除并同步' }))
    await waitFor(() => expect(service.sync).toHaveBeenCalledWith(guarded.id, { allowBulkDelete: true }))
  })

  it('imports an OpenSSH alias and selects a compatible engine automatically', async () => {
    const service = api({
      listOpenSshHosts: vi.fn(async () => [{
        alias: 'build-box', host: '10.0.0.20', port: 2_222, username: 'builder',
        identityFiles: ['~/.ssh/id_build'], proxyJump: 'jump-box',
      }]),
    })
    render(<SshWorkspaceView api={service} />)
    await screen.findByText('研发服务器')
    fireEvent.click(screen.getByRole('button', { name: '添加远程工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '从 OpenSSH 配置导入' }))
    const aliases = await screen.findByRole('combobox', { name: '选择 OpenSSH 主机' })
    fireEvent.change(aliases, { target: { value: 'build-box' } })
    expect((screen.getByLabelText('服务器地址') as HTMLInputElement).value).toBe('10.0.0.20')
    expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('builder')
    expect((screen.getByLabelText('连接引擎') as HTMLSelectElement).value).toBe('system')
    expect((screen.getByLabelText('认证方式') as HTMLSelectElement).value).toBe('openssh-config')
    expect((screen.getByLabelText('OpenSSH 主机别名') as HTMLInputElement).value).toBe('build-box')
  })

  it('invalidates a successful probe when a connection-defining field changes', async () => {
    const service = api()
    render(<SshWorkspaceView api={service} />)
    await screen.findByText('研发服务器')
    fireEvent.click(screen.getByRole('button', { name: '添加远程工作区' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '测试机' } })
    fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: '10.0.0.2' } })
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('服务器目录'), { target: { value: '/srv/project' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'runtime-only-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    const create = await screen.findByRole('button', { name: '创建工作区' }) as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.change(screen.getByLabelText('服务器目录'), { target: { value: '/srv/other' } })
    expect(create.disabled).toBe(true)
    expect(screen.queryByText(/连接成功，主机指纹/u)).toBeNull()
  })

  it('returns the registered workspace id to the native Add workspace flow', async () => {
    const service = api()
    const onCreated = vi.fn()
    render(<SshWorkspaceCreateFlow api={service} open busy={false} onCreated={onCreated} onCancel={vi.fn()} onError={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '测试机' } })
    fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: '10.0.0.2' } })
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('服务器目录'), { target: { value: '/srv/project' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'runtime-only-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    const create = screen.getByRole('button', { name: '创建工作区' }) as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('workspace-1'))
  })

  it('discovers a remote listener and starts a loopback port forward', async () => {
    const service = api({
      detectPorts: vi.fn(async () => [{ host: '0.0.0.0', port: 3_000, process: 'node' }]),
      listForwards: vi.fn(async () => []),
    })
    render(<SshWorkspaceView api={service} />)
    await screen.findByText('研发服务器')
    fireEvent.click(screen.getByRole('button', { name: '端口转发' }))
    expect(await screen.findByText('0.0.0.0:3000')).toBeTruthy()
    expect(screen.getByText('node')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '转发到本机' }))
    await waitFor(() => expect(service.addForward).toHaveBeenCalledWith(profile.id, 3_000, 3_000, '127.0.0.1'))
  })

  it('shows an interrupted forward and can retry or clear its saved rule', async () => {
    const interrupted = {
      id: 'forward-broken', profileId: profile.id, remoteHost: '127.0.0.1', remotePort: 8_080,
      localHost: '127.0.0.1', localPort: 8_080, createdAt: new Date(0).toISOString(), state: 'error' as const,
      lastError: 'SSH 连接已断开',
    }
    const service = api({
      detectPorts: vi.fn(async () => [{ host: '127.0.0.1', port: 8_080, process: 'python app.py' }]),
      listForwards: vi.fn(async () => [interrupted]),
    })
    render(<SshWorkspaceView api={service} />)
    await screen.findByText('研发服务器')
    fireEvent.click(screen.getByRole('button', { name: '端口转发' }))
    expect(await screen.findByText('转发已中断')).toBeTruthy()
    expect(screen.getByText('python app.py')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(service.restartForward).toHaveBeenCalledWith('forward-broken'))
    fireEvent.click(screen.getByRole('button', { name: '清理' }))
    await waitFor(() => expect(service.removeForward).toHaveBeenCalledWith('forward-broken'))
  })

  it('keeps a saved forward visible when the remote process is no longer detected', async () => {
    const saved = {
      id: 'forward-saved', profileId: profile.id, remoteHost: '127.0.0.1', remotePort: 9_000,
      localHost: '127.0.0.1', localPort: 9_000, createdAt: new Date(0).toISOString(), state: 'error' as const,
      lastError: '远端进程没有监听该端口',
    }
    const service = api({
      detectPorts: vi.fn(async () => { throw new Error('服务器暂时离线') }),
      listForwards: vi.fn(async () => [saved]),
    })
    render(<SshWorkspaceView api={service} />)
    await screen.findByText('研发服务器')
    fireEvent.click(screen.getByRole('button', { name: '端口转发' }))
    expect(await screen.findByText('127.0.0.1:9000')).toBeTruthy()
    expect(screen.getByText('转发已中断')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('已显示保存的转发规则')
  })
})
