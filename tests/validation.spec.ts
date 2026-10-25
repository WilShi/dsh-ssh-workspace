import { describe, expect, it } from 'vitest'
import { normalizeFingerprint, normalizeProfileInput, normalizeRemotePath, safeRelativePath } from '../src/validation.ts'

describe('SSH Workspace validation', () => {
  it('normalizes a valid password profile without exposing defaults to the caller', () => {
    const value = normalizeProfileInput({
      name: '测试服务器',
      host: 'ssh.example.internal',
      username: 'developer',
      remotePath: '/home/developer/project/../project',
      authMode: 'password',
      workspaceMode: 'direct',
      password: 'secret',
    })
    expect(value).toMatchObject({
      name: '测试服务器',
      host: 'ssh.example.internal',
      port: 22,
      username: 'developer',
      remotePath: '/home/developer/project',
      authMode: 'password',
      pollIntervalMs: 5_000,
    })
    expect(value.excludes).toEqual(expect.arrayContaining(['.git', 'node_modules', '.dsh-conflicts']))
  })

  it('defaults new connections to direct mode while accepting explicit mirror mode', () => {
    const base = { name: 'server', host: 'server.internal', username: 'user', remotePath: '/srv', authMode: 'agent' as const }
    expect(normalizeProfileInput(base).workspaceMode).toBe('direct')
    expect(normalizeProfileInput({ ...base, workspaceMode: 'mirror' }).workspaceMode).toBe('mirror')
  })

  it('rejects URLs, relative remote paths, and traversal cache entries', () => {
    expect(() => normalizeProfileInput({
      name: 'bad', host: 'ssh://server', username: 'u', remotePath: '/srv', authMode: 'agent',
    })).toThrow(/服务器地址/u)
    expect(() => normalizeRemotePath('srv/project')).toThrow(/绝对路径/u)
    expect(() => safeRelativePath('../outside')).toThrow(/越界/u)
    expect(() => safeRelativePath('/outside')).toThrow(/越界/u)
  })

  it('requires the exact SHA256 host-key shape', () => {
    const fingerprint = `SHA256:${'A'.repeat(43)}`
    expect(normalizeFingerprint(fingerprint, true)).toBe(fingerprint)
    expect(() => normalizeFingerprint('MD5:aa', true)).toThrow(/主机指纹/u)
  })

  it('rejects connection-engine combinations that cannot work', () => {
    const base = { name: 'server', host: 'server.internal', username: 'user', remotePath: '/srv', authMode: 'agent' as const }
    expect(() => normalizeProfileInput({
      ...base, transportMode: 'system', helperMode: 'disabled',
    })).toThrow(/需要远端助手/u)
    expect(() => normalizeProfileInput({
      ...base, authMode: 'password', password: 'secret', transportMode: 'system',
    })).toThrow(/OpenSSH 配置或 SSH Agent/u)
    expect(() => normalizeProfileInput({
      ...base, openSshHost: 'jumped-host',
    })).toThrow(/只能与 OpenSSH 配置认证/u)
  })
})
