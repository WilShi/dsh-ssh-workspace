import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DSH_SSH_HELPER_SOURCE, DSH_SSH_HELPER_VERSION } from '../src/remote-helper-source.ts'

let root = ''
let script = ''

async function run(args: readonly string[], input?: Buffer | string): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  const child = spawn('python', [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)))
  if (input === undefined) child.stdin.end()
  else child.stdin.end(input)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-ssh-helper-'))
  script = join(root, 'helper.py')
  await writeFile(script, DSH_SSH_HELPER_SOURCE, 'utf8')
})

afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('versioned remote SSH helper', () => {
  it('probes, scans, hashes, streams and atomically writes files', async () => {
    const probe = await run(['probe'])
    expect(probe.code).toBe(0)
    expect(JSON.parse(probe.stdout.toString('utf8'))).toMatchObject({ version: DSH_SSH_HELPER_VERSION })
    const ports = await run(['ports'])
    expect(ports.code).toBe(0)

    const workspace = join(root, 'workspace')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'node_modules'), { recursive: true })
    await writeFile(join(workspace, 'src', 'value.txt'), 'first\n')
    await writeFile(join(workspace, 'node_modules', 'ignored.txt'), 'ignored\n')
    const excludes = Buffer.from(JSON.stringify(['node_modules']), 'utf8').toString('base64url')
    const scan = await run(['scan', workspace, excludes])
    expect(scan.code).toBe(0)
    const rows = scan.stdout.toString('utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line) as { path: string })
    expect(rows.map(row => row.path)).toContain('src/value.txt')
    expect(rows.map(row => row.path)).not.toContain('node_modules/ignored.txt')

    const hash = await run(['hash', join(workspace, 'src', 'value.txt')])
    expect(JSON.parse(hash.stdout.toString('utf8'))).toMatchObject({ size: 6 })

    const payload = Buffer.from('second\0binary\n')
    const target = join(workspace, 'src', 'written.bin')
    const written = await run(['write', target, String(payload.length + 1)], payload)
    expect(written.code).toBe(0)
    expect(JSON.parse(written.stdout.toString('utf8'))).toMatchObject({ size: payload.length })
    const downloaded = await run(['read', target])
    expect(downloaded.code).toBe(0)
    expect(downloaded.stdout).toEqual(payload)
    const ranged = await run(['read-range', target, '2', '6'])
    expect(ranged.code).toBe(0)
    expect(ranged.stdout).toEqual(payload.subarray(2, 8))
    expect(await readFile(target)).toEqual(payload)
  })
})
