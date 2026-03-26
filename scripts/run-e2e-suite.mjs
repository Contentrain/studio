import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const root = new URL('..', import.meta.url)
const e2eDir = new URL('../tests/e2e', import.meta.url)

const extraArgs = process.argv.slice(2)
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

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
}
