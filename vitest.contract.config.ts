import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Standalone config for the DatabaseProvider contract suite.
 *
 * Separate from vitest.config.ts on purpose: the main config awaits
 * defineVitestProject (Nuxt env) at load time, which the contract suite —
 * and the lean CI job that runs it against a plain Postgres service with
 * `pnpm install --ignore-scripts` — neither needs nor wants.
 *
 * Run with: pnpm test:contract   (CONTRACT_PG_URL overrides the target DB)
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: rootDir,
  test: {
    root: rootDir,
    name: 'contract',
    globals: true,
    include: ['tests/contract/**/*.contract.test.ts'],
    environment: 'node',
    setupFiles: ['tests/contract/setup.ts'],
    globalSetup: ['tests/contract/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Specs share one database — no cross-file parallelism.
    fileParallelism: false,
  },
})
