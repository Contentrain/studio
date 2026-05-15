import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const root = new URL('..', import.meta.url)
const e2eDir = new URL('../tests/e2e', import.meta.url)

const extraArgs = process.argv.slice(2)
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

// All e2e suites bind Nuxt to this port (see tests/e2e/*.e2e.test.ts).
// Each suite is run as its own `vitest run` process; we must wait for the
// previous suite's Nuxt server to release the socket before spawning the
// next one, otherwise the next boot fails with EADDRINUSE.
const E2E_PORT = 4327
const E2E_HOST = '127.0.0.1'
const PORT_FREE_TIMEOUT_MS = 15_000
const PORT_FREE_POLL_MS = 200

async function isPortFree(port, host) {
  return new Promise((resolve) => {
    const tester = createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen(port, host)
  })
}

async function waitForPortFree(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortFree(port, host)) return
    await new Promise(r => setTimeout(r, PORT_FREE_POLL_MS))
  }
  throw new Error(`Port ${port} on ${host} still in use after ${timeoutMs}ms`)
}

const files = (await readdir(e2eDir))
  .filter(name => name.endsWith('.e2e.test.ts'))
  .sort()

for (const file of files) {
  const filePath = join('tests', 'e2e', file)
  console.log(`\n[e2e] ${filePath}`)

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      pnpmBin,
      ['exec', 'vitest', 'run', '--project', 'e2e', filePath, ...extraArgs],
      {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
      },
    )

    child.on('error', reject)
    child.on('exit', code => resolve(code ?? 1))
  })

  if (exitCode !== 0) {
    process.exit(exitCode)
  }

  await waitForPortFree(E2E_PORT, E2E_HOST, PORT_FREE_TIMEOUT_MS)
}
