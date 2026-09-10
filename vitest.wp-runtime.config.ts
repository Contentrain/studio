import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import contractConfig from './vitest.contract.config'

// Isolated HTTP + database acceptance; never part of the mocked API suite.
export default defineConfig({
  ...contractConfig,
  resolve: { alias: { '~~': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { ...contractConfig.test, include: ['tests/wp-runtime/**/*.test.ts'] },
})
