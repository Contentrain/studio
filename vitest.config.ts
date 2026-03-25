import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

process.env.NUXT_SESSION_SECRET ??= 'test-session-secret-32-characters-min'
process.env.NUXT_PUBLIC_SITE_URL ??= 'http://localhost:3000'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
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
    ],
  },
})
