/**
 * Migration media jobs for the Supabase DatabaseProvider.
 * Behavior parity with postgres-db/migration-media.ts.
 *
 * Both tables are service-role only (RLS on, no policies), so every query uses
 * the admin client. Claim, settle and finish are the SQL functions of
 * migration 037, shared with the plain-Postgres provider.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

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

const OPEN = ['preparing', 'queued', 'running', 'paused_quota']
const ITEM_CHUNK = 500
/** A `preparing` job older than this was left by a start that did not finish. */
const PREPARING_STALE_MS = 10 * 60_000

function fail(message: string): never {
  throw createError({ statusCode: 500, message })
}

export function migrationMediaMethods(): MigrationMediaMethods {
  async function openJob(projectId: string): Promise<DatabaseRow | null> {
    const { data, error } = await getAdmin()
      .from('migration_media_jobs')
      .select('*')
      .eq('project_id', projectId)
      .in('status', OPEN)
      .maybeSingle()
    if (error) fail(error.message)
    return (data as DatabaseRow | null) ?? null
  }

  return {
    async createMigrationMediaJob(input) {
      const existing = await openJob(input.projectId)
      // A job left `preparing` by a start that died mid-insert would hold the project's one open slot forever.
      const abandoned = existing?.status === 'preparing' && Date.parse(String(existing.updated_at)) < Date.now() - PREPARING_STALE_MS
      if (existing && !abandoned) return { job: existing, created: false }
      if (existing) await getAdmin().from('migration_media_jobs').delete().eq('id', existing.id).eq('status', 'preparing')

      const admin = getAdmin()
      const { data: job, error } = await admin
        .from('migration_media_jobs')
        .insert({
          project_id: input.projectId,
          workspace_id: input.workspaceId,
          created_by: input.createdBy,
          manifest_ref: input.manifestRef,
          manifest_commit: input.manifestCommit,
          total: input.items.length,
          // Not claimable until every item is in: the worker only takes queued/running jobs.
          status: input.items.length === 0 ? 'done' : 'preparing',
        })
        .select()
        .single()
      if (error) {
        // Two starts at once: the one-open-job index lets one through; the other returns it.
        if (error.code === '23505') {
          const raced = await openJob(input.projectId)
          if (raced) return { job: raced, created: false }
        }
        fail(error.message)
      }

      // No transaction over the REST client: a failed item insert removes the job it belongs to.
      for (let i = 0; i < input.items.length; i += ITEM_CHUNK) {
        const { error: itemsError } = await admin
          .from('migration_media_items')
          .insert(input.items.slice(i, i + ITEM_CHUNK).map(item => ({
            job_id: job.id,
            repo_path: item.repoPath,
            blob_sha: item.blobSha,
            bytes: item.bytes,
            mime: item.mime,
            width: item.width ?? null,
            height: item.height ?? null,
            alt: item.alt ?? null,
          })))
        if (itemsError) {
          await admin.from('migration_media_jobs').delete().eq('id', job.id)
          fail(itemsError.message)
        }
      }
      if (input.items.length === 0) return { job: job as DatabaseRow, created: true }
      const { data: queued, error: queueError } = await admin
        .from('migration_media_jobs')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', job.id)
        .eq('status', 'preparing')
        .select()
        .single()
      if (queueError) fail(queueError.message)
      return { job: queued as DatabaseRow, created: true }
    },

    async getMigrationMediaJob(projectId, jobId) {
      const { data, error } = await getAdmin()
        .from('migration_media_jobs')
        .select('*')
        .eq('id', jobId)
        .eq('project_id', projectId)
        .maybeSingle()
      if (error) fail(error.message)
      return (data as DatabaseRow | null) ?? null
    },

    async getLatestMigrationMediaJob(projectId) {
      const { data, error } = await getAdmin()
        .from('migration_media_jobs')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) fail(error.message)
      return (data as DatabaseRow | null) ?? null
    },

    async claimMigrationMediaJob(now, leaseSeconds) {
      const { data, error } = await getAdmin().rpc('claim_migration_media_job', {
        p_now: now.toISOString(),
        p_lease_seconds: leaseSeconds,
      })
      if (error) fail(error.message)
      return ((data ?? []) as DatabaseRow[])[0] ?? null
    },

    async listPendingMigrationMediaItems(jobId, limit) {
      const { data, error } = await getAdmin()
        .from('migration_media_items')
        .select('*')
        .eq('job_id', jobId)
        .eq('state', 'pending')
        .order('repo_path')
        .limit(limit)
      if (error) fail(error.message)
      return (data ?? []) as DatabaseRow[]
    },

    async listMigrationMediaItems(jobId, state, limit) {
      const { data, error } = await getAdmin()
        .from('migration_media_items')
        .select('*')
        .eq('job_id', jobId)
        .eq('state', state)
        .order('repo_path')
        .limit(limit)
      if (error) fail(error.message)
      return (data ?? []) as DatabaseRow[]
    },

    async settleMigrationMediaItem(input, now) {
      const { data, error } = await getAdmin().rpc('settle_migration_media_item', {
        p_job: input.jobId,
        p_token: input.token,
        p_path: input.repoPath,
        p_ok: input.ok,
        p_asset: input.assetId ?? null,
        p_delivery_url: input.deliveryUrl ?? null,
        p_deduped: input.deduped ?? false,
        p_error: input.error ?? null,
        p_status_code: input.statusCode ?? null,
        p_now: now.toISOString(),
      })
      if (error) fail(error.message)
      return data === true
    },

    async finishMigrationMediaJob(jobId, token, status, reason, now) {
      const { data, error } = await getAdmin().rpc('finish_migration_media_job', {
        p_job: jobId,
        p_token: token,
        p_status: status,
        p_error: reason,
        p_now: now.toISOString(),
      })
      if (error) fail(error.message)
      return data === true
    },

    async resumeMigrationMediaJob(projectId, jobId) {
      const { data, error } = await getAdmin()
        .from('migration_media_jobs')
        .update({ status: 'queued', error: null, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('project_id', projectId)
        .eq('status', 'paused_quota')
        .select()
        .maybeSingle()
      if (error) fail(error.message)
      return (data as DatabaseRow | null) ?? null
    },
  }
}
