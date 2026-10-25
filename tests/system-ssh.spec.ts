import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listOpenSshHosts, resolveSystemSshExecutable } from '../src/system-ssh.ts'

const roots: string[] = []
afterEach(async () => { while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true }) })

describe('system OpenSSH configuration', () => {
  it('discovers included hosts and resolves their effective settings', async () => {
    await expect(resolveSystemSshExecutable()).resolves.toMatch(/ssh(?:\.exe)?$/iu)
    const root = await mkdtemp(join(tmpdir(), 'dsh-openssh-config-'))
    roots.push(root)
    const includedDirectory = join(root, 'conf.d')
    await mkdir(includedDirectory)
    const included = join(includedDirectory, 'servers.conf')
    await writeFile(included, [
      'Host jump-box',
      '  HostName 10.0.0.10',
      '  User gateway',
      'Host build-box',
      '  HostName 10.0.0.20',
      '  User builder',
      '  Port 2222',
      '  ProxyJump jump-box',
      '  IdentityFile ~/.ssh/id_build',
    ].join('\n'))
    const config = join(root, 'config')
    await writeFile(config, `Include ${included.replaceAll('\\', '/')}\n`)
    const rows = await listOpenSshHosts(config)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: 'jump-box', host: '10.0.0.10', username: 'gateway' }),
      expect.objectContaining({ alias: 'build-box', host: '10.0.0.20', username: 'builder', port: 2222, proxyJump: 'jump-box' }),
    ]))
  })
})

