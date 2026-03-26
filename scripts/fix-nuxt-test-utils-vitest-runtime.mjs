import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const runtimeFiles = [
  'dist/vitest-environment.mjs',
  'dist/vitest-environment.d.mts',
]

async function patchFile(filePath) {
  const source = await readFile(filePath, 'utf8')
  const next = source.replaceAll('vitest/environments', 'vitest/runtime')

  if (next !== source) {
    await writeFile(filePath, next, 'utf8')
  }
}

async function main() {
  let packageRoot

  try {
    const configPath = fileURLToPath(await import.meta.resolve('@nuxt/test-utils/config'))
    packageRoot = dirname(dirname(configPath))
  }
  catch {
    return
  }

  await Promise.all(runtimeFiles.map(async (relativePath) => {
    const absolutePath = join(packageRoot, relativePath)
    await patchFile(absolutePath)
  }))
}

await main()
