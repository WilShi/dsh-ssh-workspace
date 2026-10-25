import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SafeSshProfile,
  SshDetectedPort,
  SshPortForward,
} from '../src/types.ts'
import type { SshWorkspaceApi } from './api.ts'
import { SshWorkspaceDialog } from './SshWorkspaceDialog.tsx'
import css from './SshWorkspaceView.module.css'

export interface SshWorkspaceViewProps {
  api: SshWorkspaceApi
  close?: () => void
}

function phaseLabel(profile: SafeSshProfile): string {
  switch (profile.status.phase) {
    case 'idle': return profile.workspaceMode === 'direct' ? '等待连接' : '等待同步'
    case 'connecting': return '正在连接'
    case 'syncing': return '同步中'
    case 'ready': return profile.workspaceMode === 'direct' ? '直连可用' : '已同步'
    case 'conflict': return `${profile.status.conflictCount} 个冲突`
    case 'error': return '连接异常'
  }
}

function lastSync(profile: SafeSshProfile): string {
  if (profile.workspaceMode === 'direct') return '文件按需读取并直接写回服务器'
  const last = profile.status.lastSyncAt === undefined
    ? '尚未完成同步'
    : `上次同步 ${new Date(profile.status.lastSyncAt).toLocaleString()}`
  if (profile.status.nextRetryAt === undefined) return last
  return `${last} · 自动重试 ${new Date(profile.status.nextRetryAt).toLocaleTimeString()}`
}

function remoteHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

function visiblePorts(
  profileId: string,
  detected: readonly SshDetectedPort[],
  forwards: readonly SshPortForward[],
): readonly SshDetectedPort[] {
  const rows = [...detected]
  for (const forward of forwards) {
    if (forward.profileId !== profileId) continue
    const exists = rows.some(port => port.port === forward.remotePort && remoteHost(port.host) === forward.remoteHost)
    if (!exists) rows.push({ host: forward.remoteHost, port: forward.remotePort })
  }
  return rows.sort((left, right) => left.port - right.port || left.host.localeCompare(right.host))
}

export function SshWorkspaceView({ api }: SshWorkspaceViewProps) {
  const [profiles, setProfiles] = useState<readonly SafeSshProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogProfile, setDialogProfile] = useState<SafeSshProfile | 'new' | null>(null)
  const [forwards, setForwards] = useState<readonly SshPortForward[]>([])
  const [portsForProfile, setPortsForProfile] = useState<string | null>(null)
  const [detectedPorts, setDetectedPorts] = useState<readonly SshDetectedPort[]>([])
  const errorRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try { setProfiles(await api.list()) }
    catch (cause) { if (!quiet) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (!quiet) setLoading(false) }
  }, [api])

  useEffect(() => {
    void refresh()
    const timer = globalThis.setInterval(() => { void refresh(true) }, 5_000)
    return () => globalThis.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const refreshForwards = () => { void api.listForwards().then(setForwards).catch(() => {}) }
    refreshForwards()
    const timer = globalThis.setInterval(refreshForwards, 5_000)
    return () => globalThis.clearInterval(timer)
  }, [api])

  // A settings section is a full management page; the chat composer has no
  // valid context here and would otherwise compress the form vertically.
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.sshWorkspaceHideComposer = ''
    style.textContent = '[data-composer-seat]{display:none!important}'
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  useEffect(() => {
    if (error === null) return
    const frame = globalThis.requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: 'nearest' }))
    return () => globalThis.cancelAnimationFrame(frame)
  }, [error])

  const summary = useMemo(() => ({
    all: profiles.length,
    ready: profiles.filter(profile => profile.status.phase === 'ready').length,
    problems: profiles.filter(profile => profile.status.phase === 'error' || profile.status.phase === 'conflict').length,
  }), [profiles])

  const showPorts = async (profile: SafeSshProfile) => {
    if (busy !== null) return
    if (portsForProfile === profile.id) { setPortsForProfile(null); return }
    setBusy(`ports:${profile.id}`)
    setError(null)
    try {
      const active = await api.listForwards()
      setForwards(active)
      try {
        setDetectedPorts(await api.detectPorts(profile.id))
      } catch (cause) {
        setDetectedPorts([])
        if (!active.some(item => item.profileId === profile.id)) throw cause
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(`暂时无法发现服务器端口；已显示保存的转发规则。${message}`)
      }
      setPortsForProfile(profile.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(null) }
  }

  const addForward = async (profile: SafeSshProfile, port: SshDetectedPort) => {
    if (busy !== null) return
    setBusy(`forward:${profile.id}:${String(port.port)}`)
    setError(null)
    try {
      await api.addForward(profile.id, port.port, port.port, port.host === '0.0.0.0' || port.host === '::' ? '127.0.0.1' : port.host)
      setForwards(await api.listForwards())
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(null) }
  }

  const removeForward = async (id: string) => {
    if (busy !== null) return
    setBusy(`remove-forward:${id}`)
    try { await api.removeForward(id); setForwards(await api.listForwards()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(null) }
  }

  const restartForward = async (id: string) => {
    if (busy !== null) return
    setBusy(`restart-forward:${id}`)
    setError(null)
    try { await api.restartForward(id); setForwards(await api.listForwards()) }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setForwards(await api.listForwards().catch(() => forwards))
    } finally { setBusy(null) }
  }

  const sync = async (profile: SafeSshProfile, allowBulkDelete = false) => {
    if (busy !== null) return
    setBusy(`sync:${profile.id}`)
    setError(null)
    try { await api.sync(profile.id, { allowBulkDelete }); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh(true) }
    finally { setBusy(null) }
  }

  const confirmBulkDelete = async (profile: SafeSshProfile) => {
    const guard = profile.status.deletionGuard
    if (guard === undefined || busy !== null) return
    if (!globalThis.confirm(
      `检测到 ${guard.candidateCount} 个文件可能被删除。只有在你确认这是预期的批量删除时才继续，是否确认？`,
    )) return
    await sync(profile, true)
  }

  const remove = async (profile: SafeSshProfile) => {
    if (busy !== null || !globalThis.confirm(`移除远程工作区“${profile.name}”？本地缓存文件会保留，不会删除。`)) return
    setBusy(`delete:${profile.id}`)
    setError(null)
    try { await api.delete(profile.id); if (dialogProfile !== 'new' && dialogProfile?.id === profile.id) setDialogProfile(null); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(null) }
  }

  const clearCache = async (profile: SafeSshProfile) => {
    if (busy !== null || !globalThis.confirm(
      `清理“${profile.name}”以前留下的本地镜像文件？服务器文件不会受影响。请先确认旧镜像里没有尚未同步的重要修改。`,
    )) return
    setBusy(`clear-cache:${profile.id}`)
    setError(null)
    try {
      const removed = await api.clearCache(profile.id)
      globalThis.alert(`本地旧镜像缓存已清理，共移除 ${removed} 个顶层条目。`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(null) }
  }

  const resolveConflict = async (profile: SafeSshProfile, path: string, strategy: 'local' | 'remote') => {
    if (busy !== null) return
    const source = strategy === 'local' ? '本地缓存版本' : '服务器版本'
    if (!globalThis.confirm(`使用${source}解决“${path}”的冲突？另一版本仍会保留在冲突副本中。`)) return
    setBusy(`conflict:${profile.id}:${path}`)
    setError(null)
    try { await api.resolveConflict(profile.id, path, strategy); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(null) }
  }

  return (
    <div className={css.root} data-ssh-workspace-view>
      <header className={css.header}>
        <div>
          <h2 className={css.title}>远程工作区</h2>
          <p className={css.subtitle}>Agent 和模型仍在本机运行，通过 SSH 直接编辑、搜索和执行服务器目录。</p>
        </div>
        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => { setDialogProfile('new'); setError(null) }}>添加远程工作区</Button>
      </header>

      <div className={css.summary} aria-label="远程工作区概况">
        <span><strong>{summary.all}</strong> 个连接</span>
        <span><strong>{summary.ready}</strong> 个可用</span>
        <span className={summary.problems > 0 ? css.problemText : ''}><strong>{summary.problems}</strong> 个待处理</span>
      </div>

      {error !== null ? <div ref={errorRef} className={css.error} role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭错误">×</button></div> : null}

      {dialogProfile !== null ? (
        <SshWorkspaceDialog
          api={api}
          open
          profile={dialogProfile === 'new' ? undefined : dialogProfile}
          onClose={() => setDialogProfile(null)}
          onSaved={() => { setDialogProfile(null); void refresh() }}
        />
      ) : null}

      {loading ? <div className={css.empty}>正在读取远程工作区…</div> : profiles.length === 0 ? (
        <div className={css.empty}><strong>还没有远程工作区</strong><span>添加后，它会和本地工作区一起出现在左侧工作区列表中。</span></div>
      ) : (
        <div className={css.grid}>
          {profiles.map(profile => (
            <article className={css.card} key={profile.id} data-profile-id={profile.id}>
              <header className={css.cardHeader}>
                <div><h3>{profile.name}</h3><p>{profile.username}@{profile.host}:{profile.port}</p></div>
                <span className={`${css.phase} ${css[`phase_${profile.status.phase}`]}`}>{phaseLabel(profile)}</span>
              </header>
              <dl className={css.details}>
                <div><dt>服务器目录</dt><dd title={profile.remotePath}>{profile.remotePath}</dd></div>
                <div><dt>访问模式</dt><dd>{profile.workspaceMode === 'direct' ? '远程直连 · 按需读取' : '本地镜像 · 双向同步'}</dd></div>
                <div><dt>{profile.workspaceMode === 'direct' ? '本地标识目录' : '本地缓存'}</dt><dd title={profile.cachePath}>{profile.cachePath}</dd></div>
                <div><dt>主机指纹</dt><dd title={profile.hostFingerprint}>{profile.hostFingerprint}</dd></div>
              </dl>
              {profile.status.capabilities !== undefined ? (
                <div className={css.capabilities} aria-label="远程连接能力">
                  <span>{profile.status.capabilities.transport === 'system' ? '系统 OpenSSH' : '内置 SSH'}</span>
                  <span>{profile.status.capabilities.helper ? `助手 v${String(profile.status.capabilities.helperVersion ?? '')}` : '纯 SSH'}</span>
                  <span>{profile.status.capabilities.realtimeFileEvents ? '实时更新' : '轮询更新'}</span>
                  <span>{profile.status.capabilities.persistentTerminals ? '终端可恢复' : '普通终端'}</span>
                </div>
              ) : null}
              {profile.status.lastError !== undefined && profile.status.deletionGuard === undefined
                ? <p className={css.cardError}>{profile.status.lastError}</p>
                : null}
              {profile.workspaceMode !== 'direct' && profile.status.deletionGuard !== undefined ? (
                <div className={css.deletionGuard}>
                  <div>
                    <strong>批量删除保护已暂停同步</strong>
                    <span>检测到 {profile.status.deletionGuard.candidateCount} / {profile.status.deletionGuard.trackedCount} 个已跟踪文件可能被删除。</span>
                  </div>
                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void confirmBulkDelete(profile)}>确认删除并同步</Button>
                </div>
              ) : null}
              {profile.workspaceMode !== 'direct' && profile.status.conflicts.length > 0 ? (
                <div className={css.conflicts}>
                  <strong>需要选择保留的版本</strong>
                  {profile.status.conflicts.map(conflict => (
                    <div className={css.conflictRow} key={conflict.path}>
                      <span title={conflict.path}>{conflict.path}</span>
                      <div>
                        <button type="button" disabled={busy !== null} onClick={() => void resolveConflict(profile, conflict.path, 'local')}>用本地版本</button>
                        <button type="button" disabled={busy !== null} onClick={() => void resolveConflict(profile, conflict.path, 'remote')}>用服务器版本</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {portsForProfile === profile.id ? (
                <div className={css.portsPanel}>
                  <div className={css.portsHeader}><strong>服务器端口</strong><span>转发后可通过本机地址直接访问</span></div>
                  {visiblePorts(profile.id, detectedPorts, forwards).length === 0 ? <p className={css.hint}>暂未发现正在监听的 TCP 端口，也没有保存的转发规则。</p> : visiblePorts(profile.id, detectedPorts, forwards).map(port => {
                    const active = forwards.find(item => item.profileId === profile.id && item.remotePort === port.port && item.remoteHost === remoteHost(port.host))
                    return (
                      <div className={css.portRow} key={`${port.host}:${String(port.port)}`}>
                        <div className={css.portIdentity}>
                          <code>{port.host}:{port.port}</code>
                          {port.process === undefined || port.process.trim() === '' ? null : <span title={port.process}>{port.process}</span>}
                        </div>
                        {active === undefined
                          ? <button type="button" disabled={busy !== null} onClick={() => void addForward(profile, port)}>转发到本机</button>
                          : active.state === 'ready'
                            ? <button type="button" disabled={busy !== null} onClick={() => void removeForward(active.id)}>本机 {active.localPort} · 停止</button>
                            : <div className={css.forwardProblem}>
                                <span title={active.lastError}>转发已中断</span>
                                <button type="button" disabled={busy !== null} onClick={() => void restartForward(active.id)}>{busy === `restart-forward:${active.id}` ? '重试中…' : '重试'}</button>
                                <button type="button" disabled={busy !== null} onClick={() => void removeForward(active.id)}>清理</button>
                              </div>}
                      </div>
                    )
                  })}
                </div>
              ) : null}
              <footer className={css.cardFooter}>
                <span>{lastSync(profile)} · {profile.credentialConfigured ? '凭据已保存' : '凭据待配置'}</span>
                <div className={css.cardActions}>
                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void sync(profile)}>
                    {busy === `sync:${profile.id}` ? (profile.workspaceMode === 'direct' ? '刷新中…' : '同步中…') : (profile.workspaceMode === 'direct' ? '刷新连接' : '立即同步')}
                  </Button>
                  {profile.workspaceMode === 'direct'
                    ? <button type="button" onClick={() => void clearCache(profile)} disabled={busy !== null}>{busy === `clear-cache:${profile.id}` ? '清理中…' : '清理旧缓存'}</button>
                    : null}
                  <button type="button" onClick={() => void showPorts(profile)} disabled={busy !== null}>{portsForProfile === profile.id ? '收起端口' : '端口转发'}</button>
                  <button type="button" onClick={() => { setDialogProfile(profile); setError(null) }} disabled={busy !== null}>编辑</button>
                  <button type="button" className={css.danger} onClick={() => void remove(profile)} disabled={busy !== null}>移除</button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
