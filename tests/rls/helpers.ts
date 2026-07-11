import { spawnSync } from 'node:child_process'

/**
 * Target database resolution — the RLS suite runs against BOTH backends:
 *
 *  - Supabase local (default): `supabase start`'s Postgres on 54322,
 *    migrated by the Supabase CLI. Override with SUPABASE_DB_URL.
 *  - Plain Postgres (managed pair): set RLS_DB_URL to any migrated plain-PG
 *    instance (the throwaway `postgres:16` on 54329, or CI's 5432 service).
 *    When RLS_DB_URL is set, tests/rls/global-setup.ts applies the migration
 *    lineage first via scripts/migrate-postgres.mjs.
 *
 * The suite itself is backend-agnostic: the RLS contract is the
 * `set local role` + `request.jwt.claim.sub` GUC pair, identical on both.
 */
const defaultDbUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

export function rlsDbUrl(): string {
  return process.env.RLS_DB_URL ?? process.env.SUPABASE_DB_URL ?? defaultDbUrl
}

function runPsql(script: string) {
  const result = spawnSync('psql', [
    rlsDbUrl(),
    '-v',
    'ON_ERROR_STOP=1',
    '-X',
    '-q',
    '-t',
    '-A',
  ], {
    encoding: 'utf-8',
    input: script,
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql command failed')
  }

  return result.stdout.trim()
}

export function assertDbReachable() {
  runPsql('select 1;')
}

export function executeSql(sql: string) {
  runPsql(sql)
}

export function queryJson<T>(sql: string): T[] {
  const output = runPsql(`
copy (
  select coalesce(json_agg(rows), '[]'::json)::text
  from (${sql}) as rows
) to stdout;
`)

  return parseJsonOutput<T>(output)
}

export function queryAsUserJson<T>(userId: string, sql: string, role: 'authenticated' | 'anon' = 'authenticated'): T[] {
  const output = runPsql(`
begin;
set local role ${role};
set local "request.jwt.claim.role" = '${role}';
set local "request.jwt.claim.sub" = '${userId}';
copy (
  select coalesce(json_agg(rows), '[]'::json)::text
  from (${sql}) as rows
) to stdout;
rollback;
`)

  return parseJsonOutput<T>(output)
}

export function resetDatabase() {
  executeSql(`
truncate table public.messages cascade;
truncate table public.conversations cascade;
truncate table public.agent_usage cascade;
truncate table public.ai_keys cascade;
truncate table public.project_members cascade;
truncate table public.projects cascade;
truncate table public.workspace_members cascade;
truncate table public.workspaces cascade;
truncate table public.profiles cascade;
truncate table auth.users cascade;
`)
}

function parseJsonOutput<T>(output: string) {
  const normalized = (output || '[]')
    .replaceAll('\\n', '')
    .replaceAll('\\t', '')
    .trim()

  return JSON.parse(normalized || '[]') as T[]
}
