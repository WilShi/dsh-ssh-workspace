import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { OpenSshHostEntry, SshProfileInput, SshWorkspaceProfile } from './types.ts'
import { SshConnectionError, type RemoteCommandResult } from './ssh-client.ts'

const OUTPUT_LIMIT = 8 * 1024 * 1024
const CONFIG_HOST_LIMIT = 500

type SshTarget = Pick<SshWorkspaceProfile, 'host' | 'port' | 'username' | 'authMode' | 'openSshHost'>
  | Pick<SshProfileInput, 'host' | 'port' | 'username' | 'authMode' | 'openSshHost'>

function executableCandidates(): string[] {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    return [join(root, 'System32', 'OpenSSH', 'ssh.exe'), 'ssh.exe']
  }
  return ['/usr/bin/ssh', '/bin/ssh', 'ssh']
}

export async function resolveSystemSshExecutable(): Promise<string> {
  for (const candidate of executableCandidates()) {
    if (!isAbsolute(candidate)) return candidate
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue to the next conventional location.
    }
  }
  throw new SshConnectionError('SYSTEM_SSH_UNAVAILABLE', '系统 OpenSSH 客户端不可用')
}

function targetArgs(target: SshTarget, verbose = false): string[] {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]
  if (verbose) args.push('-vv')
  if (target.openSshHost !== undefined && target.openSshHost !== '') {
    args.push(target.openSshHost)
    return args
  }
  args.push('-p', String(target.port ?? 22), `${target.username}@${target.host}`)
  return args
}

export async function spawnSystemSsh(
  target: SshTarget,
  command: string,
  options: { readonly verbose?: boolean; readonly allocateTty?: boolean } = {},
): Promise<ChildProcessWithoutNullStreams> {
  if (target.authMode === 'password' || target.authMode === 'private-key') {
    throw new SshConnectionError(
      'SYSTEM_SSH_AUTH_UNSUPPORTED',
      '系统 OpenSSH 模式请使用 OpenSSH 配置或 SSH Agent；不会把密码或私钥口令交给外部进程',
    )
  }
  const executable = await resolveSystemSshExecutable()
  const args = targetArgs(target, options.verbose === true)
  if (options.allocateTty === true) args.unshift('-tt')
  return spawn(executable, [...args, command], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })
}

export async function spawnSystemSshTunnel(
  target: SshTarget,
  localHost: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<ChildProcessWithoutNullStreams> {
  if (target.authMode === 'password' || target.authMode === 'private-key') {
    throw new SshConnectionError('SYSTEM_SSH_AUTH_UNSUPPORTED', '系统 OpenSSH 转发需要 OpenSSH 配置或 SSH Agent')
  }
  const executable = await resolveSystemSshExecutable()
  const args = targetArgs(target)
  const destination = args.pop()
  if (destination === undefined) throw new Error('系统 OpenSSH 目标无效')
  return spawn(executable, [
    ...args,
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `${localHost}:${String(localPort)}:${remoteHost}:${String(remotePort)}`,
    destination,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
}

export async function execSystemSshCommand(
  target: SshTarget,
  cwd: string,
  command: string,
  signal?: AbortSignal,
  input?: Buffer | string,
  outputLimit = OUTPUT_LIMIT,
): Promise<RemoteCommandResult & { readonly debugStderr?: string }> {
  signal?.throwIfAborted()
  const wrapped = `cd -- ${shellQuote(cwd)} && /bin/sh -c ${shellQuote(command)}`
  const child = await spawnSystemSsh(target, wrapped)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let total = 0
  return await new Promise((resolvePromise, reject) => {
    let settled = false
    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const abort = (): void => {
      child.kill()
      finishError(signal?.reason instanceof Error ? signal.reason : new Error('远程命令已取消'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    const append = (targetChunks: Buffer[], chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += value.length
      if (total > outputLimit) {
        child.kill()
        finishError(new SshConnectionError('REMOTE_OUTPUT_LIMIT', '远程命令输出超过限制'))
        return
      }
      targetChunks.push(value)
    }
    child.stdout.on('data', chunk => append(stdout, chunk))
    child.stderr.on('data', chunk => append(stderr, chunk))
    child.once('error', finishError)
    child.once('close', (code, signalName) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resolvePromise({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code,
        ...(signalName === null ? {} : { signal: signalName }),
      })
    })
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}

export async function probeSystemSsh(
  target: SshTarget,
): Promise<{ readonly fingerprint: string; readonly serverBanner?: string }> {
  const child = await spawnSystemSsh(target, "printf '__DSH_SYSTEM_SSH_OK__\\n'", { verbose: true })
  child.stdin.end()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let total = 0
  const append = (rows: Buffer[], chunk: Buffer | string): void => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += value.length
    if (total > 2 * 1024 * 1024) child.kill()
    else rows.push(value)
  }
  child.stdout.on('data', chunk => append(stdout, chunk))
  child.stderr.on('data', chunk => append(stderr, chunk))
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  })
  const output = Buffer.concat(stdout).toString('utf8')
  const diagnostic = Buffer.concat(stderr).toString('utf8')
  if (code !== 0 || !output.includes('__DSH_SYSTEM_SSH_OK__')) {
    throw new SshConnectionError(
      'SYSTEM_SSH_CONNECT_FAILED',
      diagnostic.replace(/[\r\n]+/gu, ' ').trim().slice(-1_000) || `系统 OpenSSH 退出码：${String(code)}`,
    )
  }
  const match = /Server host key:\s+\S+\s+(SHA256:[A-Za-z0-9+/]{43}=?)/u.exec(diagnostic)
  if (match?.[1] === undefined) {
    throw new SshConnectionError('HOST_KEY_UNAVAILABLE', '系统 OpenSSH 已连接，但没有报告服务器主机指纹')
  }
  const banner = /Remote protocol version[^\r\n]*remote software version\s+([^\r\n]+)/u.exec(diagnostic)?.[1]?.trim()
  return {
    fingerprint: match[1].replace(/=$/u, ''),
    ...(banner === undefined || banner === '' ? {} : { serverBanner: banner }),
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function expandConfigPattern(pattern: string, base: string): Promise<string[]> {
  const expanded = pattern.replace(/^~(?=$|[\\/])/u, homedir())
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded)
  if (!/[?*\[]/u.test(absolute)) return [absolute]
  const folder = dirname(absolute)
  const name = absolute.slice(folder.length + 1)
  const expression = new RegExp(`^${name
    .replace(/[.+^${}()|\\]/gu, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')}$`, process.platform === 'win32' ? 'iu' : 'u')
  try {
    return (await readdir(folder)).filter(item => expression.test(item)).map(item => join(folder, item))
  } catch {
    return []
  }
}

async function collectConfigHosts(
  filename: string,
  seen: Set<string>,
  rows: Map<string, string>,
): Promise<void> {
  const key = process.platform === 'win32' ? filename.toLowerCase() : filename
  if (seen.has(key) || seen.size > 128) return
  seen.add(key)
  let content: string
  try { content = await readFile(filename, 'utf8') } catch { return }
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.replace(/\s+#.*$/u, '').trim()
    if (line === '') continue
    const match = /^(\S+)\s+(.+)$/u.exec(line)
    if (match === null) continue
    const directive = (match[1] as string).toLowerCase()
    const value = (match[2] as string).trim()
    if (directive === 'include') {
      for (const pattern of value.match(/(?:[^\s"]+|"[^"]*")+/gu) ?? []) {
        for (const include of await expandConfigPattern(pattern.replace(/^"|"$/gu, ''), dirname(filename))) {
          await collectConfigHosts(include, seen, rows)
        }
      }
    } else if (directive === 'host') {
      for (const alias of value.split(/\s+/u)) {
        if (alias === '' || alias.startsWith('!') || /[*?]/u.test(alias) || rows.size >= CONFIG_HOST_LIMIT) continue
        if (!rows.has(alias)) rows.set(alias, filename)
      }
    }
  }
}

function sshWords(raw: string): string[] {
  let line = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const character of raw) {
    if (escaped) {
      line += character
      escaped = false
    } else if (character === '\\' && quote !== "'") {
      escaped = true
      line += character
    } else if (quote !== undefined) {
      line += character
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") {
      quote = character
      line += character
    } else if (character === '#') {
      break
    } else {
      line += character
    }
  }
  return line.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/gu)?.map(value => {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1)
    }
    return value
  }) ?? []
}

function sshPatternMatches(value: string, pattern: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  return new RegExp(`^${expression}$`, 'iu').test(value)
}

function hostBlockMatches(alias: string, patterns: readonly string[]): boolean {
  let included = false
  for (const raw of patterns) {
    const excluded = raw.startsWith('!')
    const pattern = excluded ? raw.slice(1) : raw
    if (!sshPatternMatches(alias, pattern)) continue
    if (excluded) return false
    included = true
  }
  return included
}

/**
 * Windows OpenSSH rejects otherwise readable config fixtures (and some
 * enterprise-managed configs) when an inherited ACL contains an unresolved
 * SID. Keep discovery useful in that case without pretending to implement
 * advanced Match/CanonicalizeHost behavior; actual connections still go
 * through OpenSSH and therefore retain its complete semantics.
 */
async function fallbackSshConfigFor(alias: string, configPath: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  const state = { active: true }
  const visit = async (filename: string, stack: Set<string>, depth: number): Promise<void> => {
    if (depth > 32) return
    const key = process.platform === 'win32' ? filename.toLowerCase() : filename
    if (stack.has(key)) return
    let content: string
    try { content = await readFile(filename, 'utf8') } catch { return }
    const nextStack = new Set(stack).add(key)
    for (const raw of content.split(/\r?\n/u)) {
      const words = sshWords(raw)
      if (words.length === 0) continue
      let directive = (words.shift() as string).toLowerCase()
      if (directive.includes('=')) {
        const separator = directive.indexOf('=')
        words.unshift(directive.slice(separator + 1))
        directive = directive.slice(0, separator)
      }
      if (directive === 'host') {
        state.active = hostBlockMatches(alias, words)
        continue
      }
      if (directive === 'match') {
        state.active = words.length === 1 && words[0]?.toLowerCase() === 'all'
        continue
      }
      if (!state.active) continue
      if (directive === 'include') {
        for (const pattern of words) {
          for (const include of await expandConfigPattern(pattern, dirname(filename))) {
            await visit(include, nextStack, depth + 1)
          }
        }
        continue
      }
      if (!['hostname', 'user', 'port', 'identityfile', 'proxyjump'].includes(directive)) continue
      const value = words.join(' ').trim()
      if (value === '') continue
      if (directive === 'identityfile') {
        const values = result.get(directive) ?? []
        values.push(value)
        result.set(directive, values)
      } else if (!result.has(directive)) {
        result.set(directive, [value])
      }
    }
  }
  await visit(configPath, new Set(), 0)
  return result
}

async function sshConfigFor(alias: string, configPath?: string): Promise<Map<string, string[]>> {
  const executable = await resolveSystemSshExecutable()
  const child = spawn(executable, [
    ...(configPath === undefined ? [] : ['-F', configPath]),
    '-G',
    alias,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  })
  if (code !== 0) throw new Error(Buffer.concat(errors).toString('utf8').trim() || `ssh -G exited with ${String(code)}`)
  const result = new Map<string, string[]>()
  for (const line of Buffer.concat(chunks).toString('utf8').split(/\r?\n/u)) {
    const separator = line.indexOf(' ')
    if (separator <= 0) continue
    const key = line.slice(0, separator).toLowerCase()
    const values = result.get(key) ?? []
    values.push(line.slice(separator + 1).trim())
    result.set(key, values)
  }
  return result
}

export async function listOpenSshHosts(configPath = join(homedir(), '.ssh', 'config')): Promise<readonly OpenSshHostEntry[]> {
  await resolveSystemSshExecutable()
  const aliases = new Map<string, string>()
  await collectConfigHosts(configPath, new Set(), aliases)
  const entries: OpenSshHostEntry[] = []
  for (const [alias, source] of aliases) {
    try {
      const values = await sshConfigFor(alias, configPath)
      const host = values.get('hostname')?.at(-1) ?? alias
      const port = Number(values.get('port')?.at(-1) ?? 22)
      const username = values.get('user')?.at(-1)
      const identityFiles = values.get('identityfile') ?? []
      const proxyJump = values.get('proxyjump')?.at(-1)
      entries.push({
        alias,
        host,
        port: Number.isInteger(port) ? port : 22,
        ...(username === undefined ? {} : { username }),
        identityFiles,
        ...(proxyJump === undefined || proxyJump === 'none' ? {} : { proxyJump }),
        source,
      })
    } catch {
      const values = await fallbackSshConfigFor(alias, configPath)
      const host = values.get('hostname')?.at(-1) ?? alias
      const port = Number(values.get('port')?.at(-1) ?? 22)
      const username = values.get('user')?.at(-1)
      const identityFiles = values.get('identityfile') ?? []
      const proxyJump = values.get('proxyjump')?.at(-1)
      entries.push({
        alias,
        host,
        port: Number.isInteger(port) ? port : 22,
        ...(username === undefined ? {} : { username }),
        identityFiles,
        ...(proxyJump === undefined || proxyJump === 'none' ? {} : { proxyJump }),
        source,
      })
    }
  }
  return entries.sort((left, right) => left.alias.localeCompare(right.alias))
}
