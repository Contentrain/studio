import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

process.env.NUXT_SESSION_SECRET ??= 'test-session-secret-32-characters-min'
process.env.NUXT_PUBLIC_SITE_URL ??= 'http://localhost:3000'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: {
      '~': rootDir,
      '@': rootDir,
      '~~': rootDir,
      '@@': rootDir,
    },
  },
  test: {
    root: rootDir,
    globals: true,
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'json-summary'],
      include: [
        'server/api/**/*.ts',
        'server/middleware/**/*.ts',
        'server/utils/**/*.ts',
        'app/composables/**/*.ts',
        'app/components/**/*.vue',
      ],
      exclude: [
        '**/*.d.ts',
        '.nuxt/**',
        '.output/**',
        'coverage/**',
        'node_modules/**',
      ],
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/unit.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.integration.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/integration.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['tests/nuxt/**/*.nuxt.test.ts'],
          environment: 'nuxt',
          setupFiles: ['tests/setup/nuxt.ts'],
          environmentOptions: {
            nuxt: {
              rootDir,
              domEnvironment: 'happy-dom',
              mock: {
                indexedDb: true,
                intersectionObserver: true,
              },
            },
          },
        },
      }),
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.e2e.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          setupFiles: ['tests/setup/e2e.ts'],
        },
      },
      {
        test: {
          name: 'rls',
          include: ['tests/rls/**/*.rls.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/unit.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
