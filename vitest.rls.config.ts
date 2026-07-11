import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Standalone config for the RLS suite — one config, two backends:
 *
 *   pnpm test:rls                       → Supabase local (54322, default)
 *   RLS_DB_URL=postgres://… pnpm test:rls → plain Postgres (managed pair;
 *                                          global-setup migrates it first)
 *
 * Standalone for the same reason as vitest.contract.config.ts: the main
 * config awaits defineVitestProject (Nuxt env) at load time, which CI's
 * lean postgres-lineage job (`pnpm install --ignore-scripts`) neither
 * needs nor wants.
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: rootDir,
  esbuild: {
    // Bypass tsconfig file lookup: the project tsconfig references
    // .nuxt/tsconfig.*.json, which only exists after `nuxt prepare`.
    tsconfigRaw: '{}',
  },
  test: {
    root: rootDir,
    name: 'rls',
    globals: true,
    include: ['tests/rls/**/*.rls.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup/unit.ts'],
    globalSetup: ['tests/rls/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Specs share one database — no cross-file parallelism.
    fileParallelism: false,
  },
})
