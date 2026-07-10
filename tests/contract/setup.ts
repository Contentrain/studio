/**
 * Per-file setup for the contract suite.
 *
 * Stubs the Nitro globals the provider modules use (createError,
 * errorMessage, useRuntimeConfig) and points the postgres provider at the
 * contract database. Each spec file gets a fresh module registry, so
 * configuration + teardown happen per file.
 */
import { afterAll, vi } from 'vitest'
import { closePostgresDb, configurePostgresDb } from '../../server/providers/postgres-db'
import { CONTRACT_JWT_SECRET, CONTRACT_SESSION_SECRET, contractPgUrl } from './env'

vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => {
  return Object.assign(new Error(input.message), input)
})

vi.stubGlobal('errorMessage', (key: string, _params?: Record<string, unknown>) => key)

// Same idiom as errorMessage: the real accessor reads the email-templates
// content model through the Nitro auto-import; specs only assert the
// provider's URL/token behavior, not template copy.
vi.stubGlobal('emailTemplate', (slug: string, params?: Record<string, string | number>) => ({
  subject: slug,
  body: `<p><a href="${params?.url ?? ''}">${slug}</a></p>`,
}))

vi.stubGlobal('useRuntimeConfig', () => ({
  sessionSecret: CONTRACT_SESSION_SECRET,
  sessionSecretPrevious: '',
  public: { siteUrl: 'http://localhost:3000' },
  oauth: {},
}))

configurePostgresDb({ url: contractPgUrl(), authJwtSecret: CONTRACT_JWT_SECRET })

afterAll(async () => {
  await closePostgresDb()
})
