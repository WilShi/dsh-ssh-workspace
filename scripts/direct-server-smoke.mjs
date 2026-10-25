import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'ssh2'
import { SshWorkspaceManager } from '../.real-smoke-lib/manager.mjs'

process.env.DSH_SSH_HELPER_ASSET_DIR ??= join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'helpers')

const host = process.env.DSH_SSH_TEST_HOST
const username = process.env.DSH_SSH_TEST_USERNAME
const password = process.env.DSH_SSH_TEST_PASSWORD
const port = Number(process.env.DSH_SSH_TEST_PORT ?? 22)
if (!host || !username || !password) throw new Error('SSH test environment is incomplete')

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const client = new Client()
await new Promise((resolve, reject) => {
  client.once('ready', resolve).once('error', reject)
  client.connect({ host, port, username, password, readyTimeout: 15_000 })
})
const remote = async (command) => await new Promise((resolve, reject) => {
  client.exec(command, (error, stream) => {
    if (error) return reject(error)
    const stdout = []; const stderr = []
    stream.on('data', value => stdout.push(Buffer.from(value)))
    stream.stderr.on('data', value => stderr.push(Buffer.from(value)))
    stream.once('error', reject)
    stream.once('close', (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString('utf8'))
      : reject(new Error(Buffer.concat(stderr).toString('utf8') || `remote exit ${String(code)}`)))
    stream.end()
  })
})

const records = new Map()
const credentialKey = key => JSON.stringify(key)
const credentials = {
  async readRecord(key) { return records.get(credentialKey(key)) },
  async describeRecord(key) { return { configured: records.has(credentialKey(key)), writable: true } },
  async listRecords() { return [] },
  async modifyRecord(key, mutate) {
    const id = credentialKey(key); const next = await mutate(records.get(id))
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
    workspaces.set(path, workspace); return workspace
  },
  async delete() {},
}

const localRoot = await mkdtemp(join(tmpdir(), 'dsh-direct-smoke-'))
let remoteRoot
let manager
const checks = []
try {
  remoteRoot = (await remote('mktemp -d "$HOME/.dsh-direct-integration-XXXXXX"')).trim()
  assert.match(remoteRoot, /^\/.+\/\.dsh-direct-integration-[A-Za-z0-9]+$/u)
  await remote(`printf 'remote-initial\\n' > ${quote(`${remoteRoot}/initial.txt`)}; truncate -s 268435456 ${quote(`${remoteRoot}/large.bin`)}`)

  manager = new SshWorkspaceManager(credentials, registry, join(localRoot, 'dsh-home'))
  const input = {
    name: '直连真实回归', host, port, username, password, remotePath: remoteRoot,
    workspaceMode: 'direct', authMode: 'password', transportMode: 'builtin', helperMode: 'auto',
    terminalGraceSeconds: 300, pollIntervalMs: 5_000, excludes: ['.git', 'node_modules', '.dsh-conflicts'],
  }
  const probe = await manager.probe(input)
  assert.equal(probe.capabilities.sftp, true)
  assert.equal(probe.capabilities.helper, true, probe.capabilities.degradedReason)
  assert.equal(probe.capabilities.helperVersion, 10)
  checks.push('连接、主机指纹和远端助手 v10')

  const saved = await manager.saveAndCreate({ ...input, hostFingerprint: probe.fingerprint })
  assert.equal(saved.workspaceMode, 'direct')
  const localRows = await readdir(saved.cachePath)
  assert.deepEqual(localRows, ['.dsh-remote-workspace.json'])
  assert.ok((await stat(join(saved.cachePath, '.dsh-remote-workspace.json'))).size < 1024)
  checks.push('创建工作区只生成本地标识，不下载任何远程文件')

  const listing = await manager.listRemoteDirectory(saved.cachePath, saved.cachePath, 100)
  assert.deepEqual(listing.entries.map(row => row.name).sort(), ['initial.txt', 'large.bin'])
  assert.deepEqual(await readdir(saved.cachePath), ['.dsh-remote-workspace.json'])
  checks.push('目录按需列出，256MiB 大文件未落地')

  const virtualInitial = join(saved.cachePath, 'initial.txt')
  const read = await manager.readRemoteFile(saved.cachePath, virtualInitial, 1024)
  assert.equal(Buffer.from(read.bytes).toString('utf8'), 'remote-initial\n')
  assert.deepEqual(await readdir(saved.cachePath), ['.dsh-remote-workspace.json'])
  const written = await manager.writeRemoteFile(saved.cachePath, virtualInitial, Buffer.from('direct-write\n'), read.revision.token)
  assert.equal(written.strong, true)
  assert.equal(await remote(`cat -- ${quote(`${remoteRoot}/initial.txt`)}`), 'direct-write\n')
  checks.push('文件按需读取并带版本保护直接写回')

  const virtualDirectory = join(saved.cachePath, 'nested')
  await manager.createRemoteDirectory(saved.cachePath, virtualDirectory)
  await manager.writeRemoteFile(saved.cachePath, join(virtualDirectory, 'a.txt'), Buffer.from('nested\n'))
  await manager.renameRemotePath(saved.cachePath, join(virtualDirectory, 'a.txt'), join(virtualDirectory, 'b.txt'))
  assert.equal(await remote(`cat -- ${quote(`${remoteRoot}/nested/b.txt`)}`), 'nested\n')
  await manager.removeRemotePath(saved.cachePath, virtualDirectory, true)
  assert.equal((await remote(`test ! -e ${quote(`${remoteRoot}/nested`)}; printf ok`)).trim(), 'ok')
  checks.push('远程新建、写入、改名和递归删除')

  const before = await manager.remoteChangesForCachePath(saved.cachePath)
  await remote(`printf 'watch-change\\n' > ${quote(`${remoteRoot}/watched.txt`)}`)
  const deadline = Date.now() + 12_000
  let after = before
  while (Date.now() < deadline && (after?.sequence ?? 0) === (before?.sequence ?? 0)) {
    await new Promise(resolve => setTimeout(resolve, 250))
    after = await manager.remoteChangesForCachePath(saved.cachePath)
  }
  assert.ok((after?.sequence ?? 0) > (before?.sequence ?? 0))
  checks.push('服务器文件变化触发侧边栏刷新时钟')

  const command = await manager.executeForCachePath(saved.cachePath, 'pwd; printf command-ok')
  assert.equal(command.exitCode, 0)
  assert.ok(command.stdout.includes(remoteRoot))
  assert.ok(command.stdout.includes('command-ok'))
  checks.push('命令和终端仍在远程目录执行')

  assert.deepEqual(await readdir(saved.cachePath), ['.dsh-remote-workspace.json'])
  process.stdout.write(`${JSON.stringify({ ok: true, checks, capabilities: probe.capabilities }, null, 2)}\n`)
} finally {
  manager?.dispose()
  if (remoteRoot) await remote(`rm -rf -- ${quote(remoteRoot)}`).catch(() => {})
  client.end()
  await rm(localRoot, { recursive: true, force: true })
}
