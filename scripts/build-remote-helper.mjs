import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'remote-helper-go', 'main.go')
const outputRoot = process.env.DSH_SSH_HELPER_OUTPUT ?? join(root, 'lib', 'helpers')
const targets = [
  { arch: 'amd64', output: 'dsh-ssh-helper-linux-amd64' },
  { arch: 'arm64', output: 'dsh-ssh-helper-linux-arm64' },
]

await mkdir(outputRoot, { recursive: true })
for (const target of targets) {
  const output = join(outputRoot, target.output)
  await new Promise((resolve, reject) => {
    const child = spawn('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', output, source], {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, GOOS: 'linux', GOARCH: target.arch, CGO_ENABLED: '0' },
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Go helper build failed for linux/${target.arch}: ${String(code)}`)))
  })
}
