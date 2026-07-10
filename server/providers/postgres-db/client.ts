/**
 * Postgres connection + Kysely instance for the plain-Postgres
 * DatabaseProvider (managed deployments).
 *
 * Configuration is injected explicitly (configurePostgresDb) instead of
 * being read from useRuntimeConfig inside the modules: the provider factory
 * wires it from runtime config when the postgres pair ships, and the
 * contract test-suite wires it straight at a throwaway database.
 */
import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { StudioDatabase } from './types'

export interface PostgresDbConfig {
  /** postgres:// connection string (NUXT_POSTGRES_URL) */
  url: string
  /** HS256 secret that verifies managed-auth access tokens (NUXT_AUTH_JWT_SECRET) */
  authJwtSecret: string
}

let _config: PostgresDbConfig | null = null
let _pool: pg.Pool | null = null
let _db: Kysely<StudioDatabase> | null = null

const TIMESTAMPTZ_OID = 1184
const DATE_OID = 1082
const INT8_OID = 20

/**
 * PostgREST returns timestamps/dates as ISO strings and int8 aggregates as
 * plain numbers — mirror that on the pg driver so both DatabaseProvider
 * implementations hand callers identical value shapes.
 */
const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) => {
    if (oid === TIMESTAMPTZ_OID)
      return (value: string) => new Date(value).toISOString()
    if (oid === DATE_OID)
      return (value: string) => value // 'YYYY-MM-DD', not a local-midnight Date
    if (oid === INT8_OID)
      return (value: string) => Number(value)
    return pg.types.getTypeParser(oid as never, format as never)
  },
}

/** Idempotent for an identical config; reject silent re-pointing. */
export function configurePostgresDb(config: PostgresDbConfig): void {
  if (_config) {
    if (_config.url === config.url && _config.authJwtSecret === config.authJwtSecret) return
    throw new Error('[postgres-db] already configured with a different config — call closePostgresDb() first')
  }
  _config = config
}

export function getPostgresConfig(): PostgresDbConfig {
  if (!_config)
    throw new Error('[postgres-db] not configured — call configurePostgresDb() first')

  return _config
}

export function getDb(): Kysely<StudioDatabase> {
  if (!_db) {
    const { url } = getPostgresConfig()
    _pool = new pg.Pool({ connectionString: url, max: 10, types: typeParsers })
    _db = new Kysely<StudioDatabase>({ dialect: new PostgresDialect({ pool: _pool }) })
  }

  return _db
}

/** Tears down the pool (test teardown / graceful shutdown). */
export async function closePostgresDb(): Promise<void> {
  await _db?.destroy()
  _db = null
  _pool = null
  _config = null
}
