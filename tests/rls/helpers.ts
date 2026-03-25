import { spawnSync } from 'node:child_process'

const defaultDbUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

function runPsql(script: string) {
  const result = spawnSync('psql', [
    process.env.SUPABASE_DB_URL ?? defaultDbUrl,
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

export function assertLocalSupabaseDb() {
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
