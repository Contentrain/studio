/**
 * Shared environment resolution for the contract suite.
 *
 * Imported by both global-setup (migrations) and the per-file setup
 * (provider configuration) — vitest's globalSetup runs in a separate
 * context, so env defaults must be computed identically in both places
 * rather than passed through process.env mutation.
 */
export function contractPgUrl(): string {
  // CI sets CONTRACT_PG_URL to the postgres service; local runs default to
  // the throwaway container documented in tests/contract/README.md.
  return process.env.CONTRACT_PG_URL || 'postgres://postgres:postgres@localhost:54329/postgres'
}

/** HS256 secret used to mint + verify managed-auth test tokens. */
export const CONTRACT_JWT_SECRET = 'contract-suite-jwt-secret-32-chars-min'

/** Mirrors the NUXT_SESSION_SECRET default the main vitest config exports. */
export const CONTRACT_SESSION_SECRET = 'test-session-secret-32-characters-min'
