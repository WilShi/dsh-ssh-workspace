import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OpenSshHostEntry,
  SafeSshProfile,
  SshAuthMode,
  SshHelperMode,
  SshProfileInput,
  SshTransportMode,
  SshWorkspaceMode,
} from '../src/types.ts'
import type { SshWorkspaceApi } from './api.ts'
import css from './SshWorkspaceView.module.css'

interface FormState {
  id?: string
  name: string
  host: string
  port: string
  username: string
  remotePath: string
  workspaceMode: SshWorkspaceMode
  authMode: SshAuthMode
  transportMode: SshTransportMode
  openSshHost: string
  helperMode: SshHelperMode
  terminalGraceSeconds: string
  password: string
  privateKey: string
  passphrase: string
  hostFingerprint: string
  pollSeconds: string
  excludes: string
}

const EMPTY_FORM: FormState = {
  name: '', host: '', port: '22', username: '', remotePath: '', workspaceMode: 'direct', authMode: 'password',
  transportMode: 'auto', openSshHost: '', helperMode: 'auto', terminalGraceSeconds: '300',
  password: '', privateKey: '', passphrase: '', hostFingerprint: '', pollSeconds: '5',
  excludes: '.git, node_modules, .dsh-conflicts',
}

function editForm(profile: SafeSshProfile): FormState {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    remotePath: profile.remotePath,
    workspaceMode: profile.workspaceMode ?? 'mirror',
    authMode: profile.authMode,
    transportMode: profile.transportMode,
    openSshHost: profile.openSshHost ?? '',
    helperMode: profile.helperMode,
    terminalGraceSeconds: String(profile.terminalGraceSeconds),
    password: '',
    privateKey: '',
    passphrase: '',
    hostFingerprint: profile.hostFingerprint,
    pollSeconds: String(profile.pollIntervalMs / 1_000),
    excludes: profile.excludes.join(', '),
  }
}

function inputOf(form: FormState): SshProfileInput {
  const excludes = form.excludes.split(',').map(value => value.trim()).filter(Boolean)
  return {
    ...(form.id === undefined ? {} : { id: form.id }),
    name: form.name,
    host: form.host,
    port: Number(form.port),
    username: form.username,
    remotePath: form.remotePath,
    workspaceMode: form.workspaceMode,
    authMode: form.authMode,
    transportMode: form.transportMode,
    ...(form.openSshHost === '' ? {} : { openSshHost: form.openSshHost }),
    helperMode: form.helperMode,
    terminalGraceSeconds: Number(form.terminalGraceSeconds),
    ...(form.password === '' ? {} : { password: form.password }),
    ...(form.privateKey === '' ? {} : { privateKey: form.privateKey }),
    ...(form.passphrase === '' ? {} : { passphrase: form.passphrase }),
    ...(form.hostFingerprint === '' ? {} : { hostFingerprint: form.hostFingerprint }),
    pollIntervalMs: Number(form.pollSeconds) * 1_000,
    excludes,
  }
}

const INVALIDATES_PROBE = new Set<keyof FormState>([
  'host', 'port', 'username', 'remotePath', 'authMode', 'transportMode', 'openSshHost',
  'password', 'privateKey', 'passphrase', 'helperMode',
])

export interface SshWorkspaceDialogProps {
  api: SshWorkspaceApi
  open: boolean
  profile?: SafeSshProfile
  onClose: () => void
  onSaved: (profile: SafeSshProfile) => void
}

/** Native-looking create/edit dialog shared by Settings and the workspace picker. */
export function SshWorkspaceDialog({ api, open, profile, onClose, onSaved }: SshWorkspaceDialogProps) {
  const [form, setForm] = useState<FormState>(() => profile === undefined ? { ...EMPTY_FORM } : editForm(profile))
  const [busy, setBusy] = useState<'openssh-hosts' | 'probe' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probeMessage, setProbeMessage] = useState<string | null>(null)
  const [openSshHosts, setOpenSshHosts] = useState<readonly OpenSshHostEntry[]>([])

  useEffect(() => {
    if (!open) return
    setForm(profile === undefined ? { ...EMPTY_FORM } : editForm(profile))
    setBusy(null)
    setError(null)
    setProbeMessage(null)
    setOpenSshHosts([])
  }, [open, profile?.id])

  const requestClose = () => {
    if (busy === null) onClose()
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(current => ({
      ...current,
      [key]: value,
      ...(INVALIDATES_PROBE.has(key) ? { hostFingerprint: '' } : {}),
    }))
    if (INVALIDATES_PROBE.has(key)) setProbeMessage(null)
  }

  const loadOpenSshHosts = async () => {
    if (busy !== null) return
    setBusy('openssh-hosts')
    setError(null)
    try {
      const rows = await api.listOpenSshHosts()
      setOpenSshHosts(rows)
      if (rows.length === 0) setError('没有在 ~/.ssh/config 中找到可导入的主机')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(null) }
  }

  const selectOpenSshHost = (alias: string) => {
    const selected = openSshHosts.find(entry => entry.alias === alias)
    setForm(current => ({
      ...current,
      authMode: 'openssh-config',
      transportMode: 'system',
      openSshHost: alias,
      ...(selected === undefined ? {} : {
        host: selected.host,
        port: String(selected.port),
        username: selected.username ?? current.username,
        name: current.name === '' ? selected.alias : current.name,
      }),
      hostFingerprint: '',
    }))
    setProbeMessage(null)
  }

  const probe = async () => {
    if (busy !== null) return
    setBusy('probe')
    setError(null)
    setProbeMessage(null)
    try {
      const result = await api.probe(inputOf(form))
      setForm(current => ({ ...current, hostFingerprint: result.fingerprint, remotePath: result.remoteRealPath }))
      const features = [
        result.capabilities.transport === 'system' ? '系统 OpenSSH' : '内置 SSH',
        result.capabilities.helper ? `远端助手 v${String(result.capabilities.helperVersion ?? '')}` : '纯 SSH 降级',
        result.capabilities.realtimeFileEvents ? '实时文件事件' : '轮询文件变化',
        result.capabilities.persistentTerminals ? '可恢复终端' : '普通终端',
      ]
      setProbeMessage(`连接成功，主机指纹：${result.fingerprint}；${features.join(' · ')}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(null) }
  }

  const save = async () => {
    if (busy !== null || form.hostFingerprint === '') return
    setBusy('save')
    setError(null)
    try {
      const saved = await api.save(inputOf(form))
      if (saved.workspaceId === undefined || saved.workspaceId === '') throw new Error('远程连接已保存，但没有创建对应的 DSH 工作区')
      onSaved(saved)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(null) }
  }

  const title = profile === undefined ? '添加 SSH 远程工作区' : '编辑 SSH 远程工作区'
  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={title}
      description="Agent 和模型留在本机，通过安全的 SSH 连接操作服务器目录。"
      closeLabel="关闭"
      className={css.workspaceDialog}
      contentClassName={css.workspaceDialogContent}
      footer={(
        <>
          <Button variant="outline" disabled={busy !== null} onClick={requestClose}>取消</Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void probe()}>
            {busy === 'probe' ? '正在连接…' : '测试连接'}
          </Button>
          <Button variant="primary" disabled={busy !== null || form.hostFingerprint === ''} onClick={() => void save()}>
            {busy === 'save'
              ? form.workspaceMode === 'direct' ? '正在连接并创建…' : '正在同步并创建…'
              : profile === undefined ? '创建工作区' : '保存更改'}
          </Button>
        </>
      )}
    >
      <div className={css.dialogBody} data-ssh-workspace-dialog>
        <div className={css.importRow}>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void loadOpenSshHosts()}>
            {busy === 'openssh-hosts' ? '正在读取…' : '从 OpenSSH 配置导入'}
          </Button>
          {openSshHosts.length > 0 ? (
            <select value={form.openSshHost} onChange={event => selectOpenSshHost(event.target.value)} aria-label="选择 OpenSSH 主机">
              <option value="">选择 ~/.ssh/config 中的主机</option>
              {openSshHosts.map(entry => <option value={entry.alias} key={entry.alias}>{entry.alias} · {entry.username ?? ''}@{entry.host}:{entry.port}</option>)}
            </select>
          ) : <span>已有 OpenSSH 配置时可直接导入</span>}
        </div>

        <section className={css.formSection} aria-label="基本信息">
          <h3>基本信息</h3>
          <div className={css.formGrid}>
            <label><span>名称</span><input autoFocus value={form.name} onChange={event => update('name', event.target.value)} placeholder="例如：研发测试服务器" /></label>
            <label><span>服务器地址</span><input value={form.host} onChange={event => update('host', event.target.value)} placeholder="IP 或主机名" /></label>
            <label><span>SSH 端口</span><input inputMode="numeric" value={form.port} onChange={event => update('port', event.target.value)} /></label>
            <label><span>用户名</span><input value={form.username} onChange={event => update('username', event.target.value)} autoComplete="username" /></label>
            <label className={css.wide}><span>服务器目录</span><input value={form.remotePath} onChange={event => update('remotePath', event.target.value)} placeholder="/home/user/project" /></label>
          </div>
        </section>

        <section className={css.formSection} aria-label="工作方式">
          <h3>工作方式</h3>
          <div className={css.formGrid}>
            <label className={css.wide}>
              <span>文件访问模式</span>
              <select value={form.workspaceMode} onChange={event => update('workspaceMode', event.target.value as SshWorkspaceMode)}>
                <option value="direct">远程直连（推荐，不下载整个目录）</option>
                <option value="mirror">本地镜像（兼容旧工作流）</option>
              </select>
            </label>
            <p className={`${css.hint} ${css.wide}`}>
              {form.workspaceMode === 'direct'
                ? '目录和文件按需读取，编辑后直接写回服务器；本地只保留工作区标识和必要的单文件临时预览。'
                : '首次创建会完整下载远程目录，并在本地与服务器之间双向同步；大目录可能占用较多磁盘空间。'}
            </p>
          </div>
        </section>

        <section className={css.formSection} aria-label="认证">
          <h3>认证</h3>
          <div className={css.formGrid}>
            <label><span>认证方式</span><select value={form.authMode} onChange={event => {
              const authMode = event.target.value as SshAuthMode
              setForm(current => ({
                ...current,
                authMode,
                ...(authMode === 'openssh-config' ? { transportMode: 'system' as const } : { openSshHost: '' }),
                ...((authMode === 'password' || authMode === 'private-key') && current.transportMode === 'system'
                  ? { transportMode: 'auto' as const }
                  : {}),
                hostFingerprint: '',
              }))
              setProbeMessage(null)
            }}><option value="password">密码</option><option value="private-key">私钥</option><option value="agent">SSH Agent</option><option value="openssh-config">OpenSSH 配置</option></select></label>
            {form.authMode === 'openssh-config' ? <label><span>OpenSSH 主机别名</span><input value={form.openSshHost} onChange={event => update('openSshHost', event.target.value)} placeholder="例如 dev-server" /></label> : null}
            {form.authMode === 'password' ? <label><span>密码{form.id !== undefined ? '（留空保持不变）' : ''}</span><input type="password" value={form.password} onChange={event => update('password', event.target.value)} autoComplete="current-password" /></label> : null}
            {form.authMode === 'private-key' ? <><label className={css.wide}><span>私钥内容{form.id !== undefined ? '（留空保持不变）' : ''}</span><textarea value={form.privateKey} onChange={event => update('privateKey', event.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></label><label><span>私钥口令（可选）</span><input type="password" value={form.passphrase} onChange={event => update('passphrase', event.target.value)} /></label></> : null}
            {form.authMode === 'agent' ? <p className={`${css.hint} ${css.wide}`}>使用运行 DSH 的 Windows 账户所提供的 SSH Agent；不会保存额外密码。</p> : null}
            {form.authMode === 'openssh-config' ? <p className={`${css.hint} ${css.wide}`}>复用系统 OpenSSH 的 Host、Include、ProxyJump、ProxyCommand、IdentityFile、Kerberos 或安全密钥配置。</p> : null}
          </div>
        </section>

        <details className={css.advanced}>
          <summary>高级连接与{form.workspaceMode === 'direct' ? '刷新' : '同步'}设置</summary>
          <div className={css.formGrid}>
            <label><span>连接引擎</span><select value={form.transportMode} onChange={event => {
              const transportMode = event.target.value as SshTransportMode
              setForm(current => ({
                ...current,
                transportMode,
                ...(transportMode === 'system' && (current.authMode === 'password' || current.authMode === 'private-key')
                  ? { authMode: 'openssh-config' as const }
                  : {}),
                hostFingerprint: '',
              }))
              setProbeMessage(null)
            }}><option value="auto">自动选择</option><option value="builtin">内置 SSH</option><option value="system">系统 OpenSSH</option></select></label>
            <label><span>远端助手</span><select value={form.helperMode} onChange={event => update('helperMode', event.target.value as SshHelperMode)}><option value="auto">自动安装并降级兼容</option><option value="disabled">不安装，仅使用 SSH/SFTP</option></select></label>
            <label><span>断线终端保留（秒）</span><input inputMode="numeric" min="30" max="86400" value={form.terminalGraceSeconds} onChange={event => update('terminalGraceSeconds', event.target.value)} /></label>
            <label><span>自动同步间隔（秒）</span><input inputMode="numeric" min="2" max="60" value={form.pollSeconds} onChange={event => update('pollSeconds', event.target.value)} /></label>
            <label className={css.wide}><span>不同步的目录名（逗号分隔）</span><input value={form.excludes} onChange={event => update('excludes', event.target.value)} /></label>
          </div>
        </details>

        {form.hostFingerprint !== '' ? <div className={css.fingerprint}><span>已确认主机指纹</span><code>{form.hostFingerprint}</code></div> : null}
        {probeMessage !== null ? <p className={css.success} role="status">{probeMessage}</p> : null}
        {error !== null ? <div className={css.error} role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭错误">×</button></div> : null}
      </div>
    </Modal>
  )
}

export interface SshWorkspaceCreateFlowProps {
  api: SshWorkspaceApi
  open: boolean
  busy: boolean
  onCreated: (workspaceId: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

/** Slot occupant used by both native “Add workspace” entry points. */
export function SshWorkspaceCreateFlow({ api, open, busy, onCreated, onCancel, onError }: SshWorkspaceCreateFlowProps) {
  return (
    <SshWorkspaceDialog
      api={api}
      open={open}
      onClose={() => { if (!busy) onCancel() }}
      onSaved={(profile) => {
        if (profile.workspaceId === undefined || profile.workspaceId === '') onError('远程工作区已保存，但工作区注册结果无效')
        else onCreated(profile.workspaceId)
      }}
    />
  )
}
