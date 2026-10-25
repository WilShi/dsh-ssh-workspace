import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from 'ssh2'
// Load through the Desktop application's dependency tree so the plugin sees
// the same peer services it will see in the packaged product. The smoke
// command uses --preserve-symlinks to keep this resolution boundary intact.
import { SshWorkspaceManager } from '../../../dsh-plugin-desktop/node_modules/dsh-ssh-workspace/lib/index.js'

const host = process.env.DSH_SSH_TEST_HOST
const username = process.env.DSH_SSH_TEST_USER
const password = process.env.DSH_SSH_TEST_PASSWORD
if (!host || !username || !password) throw new Error('DSH_SSH_TEST_HOST, DSH_SSH_TEST_USER and DSH_SSH_TEST_PASSWORD are required')

const suffix = randomUUID().replaceAll('-', '')
const remotePath = `/home/${username}/.dsh-ssh-smoke-${suffix}`
const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-live-'))

async function rawExec(command) {
  const client = new Client()
  await new Promise((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect({ host, port: 22, username, password, readyTimeout: 15_000, hostVerifier: () => true })
  })
  try {
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) { reject(error); return }
        let stdout = ''
        let stderr = ''
        stream.on('data', chunk => { stdout += chunk.toString('utf8') })
        stream.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
        stream.once('error', reject)
        stream.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`remote exit ${code}: ${stderr}`)))
      })
    })
  } finally { client.end() }
}

class MemoryCredentials {
  records = new Map()
  async readRecord(key) { return this.records.get(String(key)) }
  async describeRecord(key) { return { configured: this.records.has(String(key)), kind: this.records.get(String(key))?.kind, writable: true } }
  async listRecords() { return [] }
  async modifyRecord(key, mutate) {
    const value = await mutate(this.records.get(String(key)))
    if (value !== undefined) this.records.set(String(key), value)
    return value
  }
  async deleteRecord(key) { this.records.delete(String(key)) }
}

class MemoryWorkspaces {
  rows = new Map()
  async resolveByPath(path) { return [...this.rows.values()].find(row => row.path === path) }
  async create(path, title = 'remote') {
    const row = {
      id: `workspace-${suffix}`,
      path,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionIds: [],
      async setTitle(next) { row.title = next },
      async attachSession() {}, async insertSessionBefore() {}, async detachSession() {}, async status() { return 'ok' },
    }
    this.rows.set(row.id, row)
    return row
  }
  async delete(id) { return this.rows.delete(String(id)) }
}

const manager = new SshWorkspaceManager(new MemoryCredentials(), new MemoryWorkspaces(), home)
let profile
try {
  await rawExec(`mkdir -p -- '${remotePath}'`)
  const input = { name: 'SSH live smoke', host, port: 22, username, remotePath, authMode: 'password', password, pollIntervalMs: 60_000 }
  const probe = await manager.probe(input)
  profile = await manager.saveAndCreate({ ...input, hostFingerprint: probe.fingerprint })

  await mkdir(join(profile.cachePath, 'src'), { recursive: true })
  await writeFile(join(profile.cachePath, 'src', 'value.txt'), 'from-local\n')
  const pushed = await manager.sync(profile.id)
  const remoteRead = await manager.executeForCachePath(profile.cachePath, 'cat src/value.txt')
  if (remoteRead.stdout !== 'from-local\n') {
    throw new Error(`local edit was not pushed: ${JSON.stringify({ stdout: remoteRead.stdout, stderr: remoteRead.stderr, exitCode: remoteRead.exitCode, sync: pushed })}`)
  }

  await manager.executeForCachePath(profile.cachePath, "printf 'from-remote\\n' > src/value.txt")
  const pulled = await manager.sync(profile.id)
  if (await readFile(join(profile.cachePath, 'src', 'value.txt'), 'utf8') !== 'from-remote\n') throw new Error('remote edit was not pulled')

  await writeFile(join(profile.cachePath, 'src', 'value.txt'), 'local-conflict\n')
  await manager.executeForCachePath(profile.cachePath, "printf 'remote-conflict\\n' > src/value.txt")
  const conflicted = await manager.sync(profile.id)
  if (conflicted.conflictCount !== 1) throw new Error('simultaneous edits did not produce a conflict')
  await manager.resolveConflict(profile.id, 'src/value.txt', 'local')
  const localWinner = await manager.executeForCachePath(profile.cachePath, 'cat src/value.txt')
  if (localWinner.stdout !== 'local-conflict\n') throw new Error('local conflict resolution did not reach the server')

  await writeFile(join(profile.cachePath, 'src', 'value.txt'), 'local-second-conflict\n')
  await manager.executeForCachePath(profile.cachePath, "printf 'remote-winner\\n' > src/value.txt")
  const conflictedAgain = await manager.sync(profile.id)
  if (conflictedAgain.conflictCount !== 1) throw new Error('second simultaneous edit did not produce a conflict')
  await manager.resolveConflict(profile.id, 'src/value.txt', 'remote')
  if (await readFile(join(profile.cachePath, 'src', 'value.txt'), 'utf8') !== 'remote-winner\n') throw new Error('remote conflict resolution did not reach the cache')

  const terminal = await manager.openTerminal('session-live', 'tab-live', profile.cachePath, 80, 24)
  if (!terminal) throw new Error('remote terminal did not open')
  if (terminal.title !== `SSH · ${profile.name}`) throw new Error('remote terminal title did not identify the SSH workspace')
  const terminalOutput = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('remote PTY timed out')), 10_000)
    const subscription = terminal.onData(data => {
      if (!data.includes('__DSH_REMOTE_PTY_OK__')) return
      clearTimeout(timeout)
      subscription.dispose()
      resolve(data)
    })
    terminal.write("printf '__DSH_REMOTE_PTY_OK__\\n'\n")
  })
  manager.closeTerminal(terminal.key)
  console.log(JSON.stringify({
    ok: true,
    fingerprint: probe.fingerprint,
    remotePath,
    pushed: pushed.filesPushed,
    pulled: pulled.filesPulled,
    conflictResolution: true,
    terminal: String(terminalOutput).includes('__DSH_REMOTE_PTY_OK__'),
  }))
} finally {
  manager.dispose()
  try {
    await rawExec(`rm -rf -- '${remotePath}'`)
    await rawExec(`test ! -e '${remotePath}'`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
