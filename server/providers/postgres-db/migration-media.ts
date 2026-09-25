/**
 * Migration media jobs for the plain-Postgres DatabaseProvider.
 * Behavior parity with supabase-db/migration-media.ts.
 *
 * Both tables are service-role only (RLS on, no policies), so every query runs
 * on the admin connection. Claim, settle and finish are the SQL functions of
 * migration 037, shared with the Supabase provider.
 */
import { sql } from 'kysely'
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

type MigrationMediaMethods = Pick<
  DatabaseProvider,
  | 'createMigrationMediaJob'
  | 'getMigrationMediaJob'
  | 'getLatestMigrationMediaJob'
  | 'claimMigrationMediaJob'
  | 'listPendingMigrationMediaItems'
  | 'listMigrationMediaItems'
  | 'settleMigrationMediaItem'
  | 'finishMigrationMediaJob'
  | 'resumeMigrationMediaJob'
>

const OPEN = ['queued', 'running', 'paused_quota']
/** Rows per insert statement — well under Postgres's parameter ceiling. */
const ITEM_CHUNK = 500

export function migrationMediaMethods(): MigrationMediaMethods {
  async function openJob(projectId: string) {
    return getAdmin()
      .selectFrom('migration_media_jobs')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('status', 'in', OPEN)
      .executeTakeFirst()
  }

  return {
    async createMigrationMediaJob(input) {
      try {
        const existing = await openJob(input.projectId)
        if (existing) return { job: existing as DatabaseRow, created: false }

        const created = await getAdmin().transaction().execute(async (trx) => {
          const job = await trx
            .insertInto('migration_media_jobs')
            .values({
              project_id: input.projectId,
              workspace_id: input.workspaceId,
              created_by: input.createdBy,
              manifest_ref: input.manifestRef,
              manifest_commit: input.manifestCommit,
              total: input.items.length,
              status: input.items.length === 0 ? 'done' : 'queued',
            } as never)
            .returningAll()
            .executeTakeFirstOrThrow()
          for (let i = 0; i < input.items.length; i += ITEM_CHUNK) {
            await trx
              .insertInto('migration_media_items')
              .values(input.items.slice(i, i + ITEM_CHUNK).map(item => ({
                job_id: job.id,
                repo_path: item.repoPath,
                blob_sha: item.blobSha,
                bytes: item.bytes,
                mime: item.mime,
                width: item.width ?? null,
                height: item.height ?? null,
                alt: item.alt ?? null,
              })))
              .execute()
          }
          return job
        }).catch(async (error: { code?: string }) => {
          // Two starts at once: the one-open-job index lets one through; the other returns it.
          if (error?.code === '23505') return null
          throw error
        })
        if (created) return { job: created as DatabaseRow, created: true }
        const raced = await openJob(input.projectId)
        if (!raced) throw new Error('migration media job vanished after a concurrent start')
        return { job: raced as DatabaseRow, created: false }
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getMigrationMediaJob(projectId, jobId) {
      try {
        const row = await getAdmin()
          .selectFrom('migration_media_jobs')
          .selectAll()
          .where('id', '=', jobId)
          .where('project_id', '=', projectId)
          .executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getLatestMigrationMediaJob(projectId) {
      try {
        const row = await getAdmin()
          .selectFrom('migration_media_jobs')
          .selectAll()
          .where('project_id', '=', projectId)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async claimMigrationMediaJob(now, leaseSeconds) {
      try {
        const result = await sql<DatabaseRow>`
          SELECT * FROM public.claim_migration_media_job(${now.toISOString()}::timestamptz, ${leaseSeconds})
        `.execute(getAdmin())
        return result.rows[0] ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listPendingMigrationMediaItems(jobId, limit) {
      try {
        const rows = await getAdmin()
          .selectFrom('migration_media_items')
          .selectAll()
          .where('job_id', '=', jobId)
          .where('state', '=', 'pending')
          .orderBy('repo_path')
          .limit(limit)
          .execute()
        return rows as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listMigrationMediaItems(jobId, state, limit) {
      try {
        const rows = await getAdmin()
          .selectFrom('migration_media_items')
          .selectAll()
          .where('job_id', '=', jobId)
          .where('state', '=', state)
          .orderBy('repo_path')
          .limit(limit)
          .execute()
        return rows as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async settleMigrationMediaItem(input, now) {
      const result = await sql<{ settled: boolean }>`
        SELECT public.settle_migration_media_item(
          ${input.jobId}::uuid, ${input.token}::uuid, ${input.repoPath}, ${input.ok},
          ${input.assetId ?? null}::uuid, ${input.deliveryUrl ?? null}, ${input.deduped ?? false},
          ${input.error ?? null}, ${input.statusCode ?? null}::integer, ${now.toISOString()}::timestamptz
        ) AS settled
      `.execute(getAdmin())
      return result.rows[0]?.settled === true
    },

    async finishMigrationMediaJob(jobId, token, status, error, now) {
      const result = await sql<{ finished: boolean }>`
        SELECT public.finish_migration_media_job(${jobId}::uuid, ${token}::uuid, ${status}, ${error}, ${now.toISOString()}::timestamptz) AS finished
      `.execute(getAdmin())
      return result.rows[0]?.finished === true
    },

    async resumeMigrationMediaJob(projectId, jobId) {
      try {
        const row = await getAdmin()
          .updateTable('migration_media_jobs')
          .set({ status: 'queued', error: null, updated_at: new Date().toISOString() } as never)
          .where('id', '=', jobId)
          .where('project_id', '=', projectId)
          .where('status', '=', 'paused_quota')
          .returningAll()
          .executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
