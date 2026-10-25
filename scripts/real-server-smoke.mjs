import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'ssh2'
import { SshWorkspaceManager } from '../.real-smoke-lib/manager.mjs'

process.env.DSH_SSH_HELPER_ASSET_DIR ??= join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'helpers')

const host = process.env.DSH_SSH_TEST_HOST
const username = process.env.DSH_SSH_TEST_USERNAME
const password = process.env.DSH_SSH_TEST_PASSWORD
const port = Number(process.env.DSH_SSH_TEST_PORT ?? 22)
if (!host || !username || !password || !Number.isInteger(port)) {
  throw new Error('Set DSH_SSH_TEST_HOST, DSH_SSH_TEST_USERNAME and DSH_SSH_TEST_PASSWORD')
}

const delay = async ms => await new Promise(resolve => setTimeout(resolve, ms))
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const waitFor = async (check, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last } catch { /* retry until deadline */ }
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const client = new Client()
await new Promise((resolve, reject) => {
  client.once('ready', resolve)
  client.once('error', reject)
  client.connect({ host, port, username, password, readyTimeout: 15_000, keepaliveInterval: 5_000 })
})

const remote = async (command, input) => await new Promise((resolve, reject) => {
  client.exec(command, (error, channel) => {
    if (error) { reject(error); return }
    const stdout = []
    const stderr = []
    channel.on('data', chunk => stdout.push(Buffer.from(chunk)))
    channel.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    channel.once('error', reject)
    channel.once('close', code => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code !== 0) reject(new Error(err.trim() || `remote command exited ${String(code)}`))
      else resolve(out)
    })
    channel.end(input)
  })
})

const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-real-'))
let remoteRoot
let serverPid
let manager
const checks = []

const records = new Map()
const credentialKey = key => JSON.stringify(key)
const credentials = {
  async readRecord(key) { return records.get(credentialKey(key)) },
  async describeRecord(key) { return { configured: records.has(credentialKey(key)), writable: true } },
  async listRecords() { return [] },
  async modifyRecord(key, mutate) {
    const id = credentialKey(key)
    const next = await mutate(records.get(id))
    if (next === undefined) records.delete(id); else records.set(id, next)
    return next
  },
  async deleteRecord(key) { records.delete(credentialKey(key)) },
}
const workspaces = new Map()
const registry = {
  async resolveByPath(path) { return workspaces.get(path) },
  async create(path, title) {
    const workspace = { id: `workspace-${randomUUID()}`, title, async setTitle(next) { this.title = next } }
    workspaces.set(path, workspace)
    return workspace
  },
  async delete(id) {
    for (const [path, workspace] of workspaces) if (workspace.id === id) workspaces.delete(path)
  },
}

const stopBackground = (target, id) => {
  const state = target.managed?.get(id)
  if (!state) return
  if (state.interval) clearInterval(state.interval)
  if (state.debounce) clearTimeout(state.debounce)
  state.interval = undefined
  state.debounce = undefined
  state.watcher?.close()
  state.watcher = undefined
  state.remoteWatcher?.close()
  state.remoteWatcher = undefined
}

try {
  remoteRoot = (await remote('mktemp -d "$HOME/.dsh-ssh-integration-XXXXXX"')).trim()
  assert.match(remoteRoot, /^\/.+\/\.dsh-ssh-integration-[A-Za-z0-9]+$/u)
  await remote(`printf 'remote-initial\\n' > ${quote(`${remoteRoot}/initial.txt`)}`)

  manager = new SshWorkspaceManager(credentials, registry, join(root, 'dsh-home'))
  const input = {
    name: '真实 SSH 回归', host, port, username, password, remotePath: remoteRoot,
    workspaceMode: 'mirror',
    authMode: 'password', transportMode: 'builtin', helperMode: 'auto', terminalGraceSeconds: 300,
    pollIntervalMs: 60_000, excludes: ['.git', 'node_modules', '.dsh-conflicts'],
  }
  const probe = await manager.probe(input)
  assert.equal(probe.capabilities.sftp, true)
  if (!probe.capabilities.helper) {
    const diagnostic = (await remote([
      "printf 'python='; python3 --version 2>&1 || true",
      "printf ' helper-dir='; if test -d \"$HOME/.dsh/ssh-helper\"; then if test -w \"$HOME/.dsh/ssh-helper\"; then printf writable; else printf readonly; fi; else printf absent; fi",
    ].join('; '))).replace(/[\r\n]+/gu, ' ')
    throw new Error(`Remote helper unavailable: ${probe.capabilities.degradedReason ?? 'unknown'}; ${diagnostic}`)
  }
  assert.equal(probe.capabilities.helper, true, probe.capabilities.degradedReason)
  assert.equal(probe.capabilities.helperVersion, 10)
  checks.push('连接、主机指纹和助手 v10')

  const fallback = await manager.probe({ ...input, helperMode: 'disabled' })
  assert.equal(fallback.capabilities.sftp, true)
  assert.equal(fallback.capabilities.helper, false)
  checks.push('纯 SFTP 降级')

  const saved = await manager.saveAndCreate({ ...input, hostFingerprint: probe.fingerprint })
  const id = saved.id
  const cache = saved.cachePath
  stopBackground(manager, id)
  assert.equal(await readFile(join(cache, 'initial.txt'), 'utf8'), 'remote-initial\n')
  checks.push('首次创建与远端拉取')

  await writeFile(join(cache, 'initial.txt'), 'local-push\n')
  let status = await manager.sync(id)
  stopBackground(manager, id)
  assert.notEqual(status.phase, 'error', status.lastError)
  assert.equal(await remote(`cat -- ${quote(`${remoteRoot}/initial.txt`)}`), 'local-push\n')
  await remote(`printf 'remote-pull\\n' > ${quote(`${remoteRoot}/initial.txt`)}`)
  status = await manager.sync(id)
  stopBackground(manager, id)
  assert.equal(await readFile(join(cache, 'initial.txt'), 'utf8'), 'remote-pull\n')
  checks.push('双向编辑、上传与下载')

  await writeFile(join(cache, 'initial.txt'), 'local-conflict\n')
  await remote(`printf 'remote-conflict\\n' > ${quote(`${remoteRoot}/initial.txt`)}`)
  status = await manager.sync(id)
  stopBackground(manager, id)
  assert.equal(status.phase, 'conflict')
  assert.equal(status.conflictCount, 1)
  await manager.resolveConflict(id, 'initial.txt', 'remote')
  assert.equal(await readFile(join(cache, 'initial.txt'), 'utf8'), 'remote-conflict\n')
  checks.push('冲突检测和显式解决')

  const command = await manager.executeForCachePath(cache, 'printf command-ok')
  assert.equal(command.exitCode, 0)
  assert.equal(command.stdout, 'command-ok')
  checks.push('Agent 远程命令')

  await remote(`dd if=/dev/zero of=${quote(`${remoteRoot}/stream.bin`)} bs=1M count=16 status=none`)
  await manager.sync(id)
  stopBackground(manager, id)
  assert.equal((await stat(join(cache, 'stream.bin'))).size, 16 * 1024 * 1024)
  await remote(`rm -f -- ${quote(`${remoteRoot}/stream.bin`)}`)
  await manager.sync(id)
  stopBackground(manager, id)
  await assert.rejects(stat(join(cache, 'stream.bin')), { code: 'ENOENT' })
  checks.push('16MiB 流式传输与删除传播')

  await manager.sync(id)
  await delay(1_200)
  await remote(`printf 'watch-ok\\n' > ${quote(`${remoteRoot}/watched.txt`)}`)
  await waitFor(async () => {
    try { return await readFile(join(cache, 'watched.txt'), 'utf8') === 'watch-ok\n' } catch { return false }
  }, 12_000, 'remote file watch synchronization')
  stopBackground(manager, id)
  checks.push('远端实时变化自动同步')

  const childServerSource = "import os,sys,SimpleHTTPServer,SocketServer;os.chdir(sys.argv[1]);s=SocketServer.TCPServer(('127.0.0.1',int(sys.argv[2])),SimpleHTTPServer.SimpleHTTPRequestHandler);s.serve_forever()"
  const serverSource = [
    'import json, os, socket, subprocess, sys, time',
    "s=socket.socket(); s.bind(('127.0.0.1',0)); port=s.getsockname()[1]; s.close()",
    'devnull=open(os.devnull,\'w\')',
    `p=subprocess.Popen([sys.executable,'-c',${JSON.stringify(childServerSource)},sys.argv[1],str(port)],stdout=devnull,stderr=devnull,close_fds=True,preexec_fn=os.setsid)`,
    'time.sleep(0.4)',
    "print(json.dumps({'port':port,'pid':p.pid}))",
  ].join('; ')
  const serverInfo = JSON.parse(await remote(`python -c ${quote(serverSource)} ${quote(remoteRoot)}`))
  serverPid = Number(serverInfo.pid)
  const remotePort = Number(serverInfo.port)
  assert.ok(Number.isInteger(serverPid) && Number.isInteger(remotePort))
  const detected = await manager.detectPorts(id)
  assert.ok(detected.some(item => item.port === remotePort))
  const forward = await manager.addPortForward(id, remotePort, 0)
  const response = await fetch(`http://127.0.0.1:${String(forward.localPort)}/initial.txt`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'remote-conflict\n')
  await manager.removePortForward(forward.id)
  checks.push('端口发现、进程信息与本地转发')

  if (probe.capabilities.persistentTerminals) {
    const terminal = await manager.openTerminal('real-session', 'real-tab', cache, 100, 32)
    assert.ok(terminal?.persistent)
    terminal.write("printf 'terminal-before\\n'\n")
    await waitFor(() => terminal.transcript.includes('terminal-before'), 8_000, 'persistent terminal output')
    manager.scheduleTerminalClose(terminal.key, 0)
    await delay(500)
    const resumed = await manager.openTerminal('real-session', 'real-tab', cache, 100, 32)
    assert.ok(resumed?.persistent)
    await waitFor(() => resumed.transcript.includes('terminal-before'), 8_000, 'persistent terminal replay')
    resumed.write("printf 'terminal-after\\n'\n")
    await waitFor(() => resumed.transcript.includes('terminal-after'), 8_000, 'resumed terminal input')
    manager.closeTerminal(resumed.key)
    checks.push('持久终端断开、续接与输入')
  } else {
    const terminal = await manager.openTerminal('real-session', 'real-tab', cache, 100, 32)
    assert.ok(terminal)
    terminal.write("printf 'terminal-fallback\\n'\n")
    await waitFor(() => terminal.transcript.includes('terminal-fallback'), 8_000, 'fallback terminal output')
    manager.closeTerminal(terminal.key)
    checks.push('普通 PTY 终端降级')
  }

  const safe = await manager.list()
  assert.equal(safe[0]?.credentialConfigured, true)
  assert.equal(JSON.stringify(safe).includes(password), false)
  assert.equal(createHash('sha256').update(password).digest('hex').length, 64)
  checks.push('凭据隔离和公开配置脱敏')

  process.stdout.write(`${JSON.stringify({ ok: true, checks, capabilities: probe.capabilities }, null, 2)}\n`)
} finally {
  try { manager?.dispose() } catch { /* best effort */ }
  if (serverPid && remoteRoot) {
    try { await remote(`kill ${String(serverPid)} 2>/dev/null || true`) } catch { /* best effort */ }
  }
  if (remoteRoot) {
    try { await remote(`rm -rf -- ${quote(remoteRoot)}`) } catch { /* isolated test directory only */ }
  }
  client.end()
  await rm(root, { recursive: true, force: true })
}
