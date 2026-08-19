/**
 * CDN key, build, and usage methods for the plain-Postgres DatabaseProvider.
 * Behavior parity with supabase-db/cdn.ts.
 */
import { sql } from 'kysely'
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError, withUser } from './helpers'

type CDNMethods = Pick<
  DatabaseProvider,
  | 'validateCDNKeyHash'
  | 'updateCDNKeyLastUsed'
  | 'countActiveCDNKeys'
  | 'createCDNKey'
  | 'createCDNKeyIfAllowed'
  | 'getCDNKey'
  | 'listCDNKeys'
  | 'revokeCDNKey'
  | 'createCDNBuild'
  | 'updateCDNBuild'
  | 'listCDNBuilds'
  | 'incrementCDNUsage'
  | 'incrementPublicCDNUsage'
  | 'getMonthlyProjectCDNUsage'
  | 'validateConversationKeyHash'
  | 'updateConversationKeyLastUsed'
>

export function cdnMethods(): CDNMethods {
  return {
    async validateCDNKeyHash(keyHash) {
      // Any failure reads as an invalid key (the Supabase impl returns null
      // on every error).
      try {
        const row = await getAdmin()
          .selectFrom('cdn_api_keys')
          .select(['id', 'project_id', 'rate_limit_per_hour', 'allowed_origins', 'scopes', 'revoked_at', 'expires_at'])
          .where('key_hash', '=', keyHash)
          .where('revoked_at', 'is', null)
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch {
        return null
      }
    },

    async updateCDNKeyLastUsed(keyId) {
      // Fire-and-forget in the Supabase impl — mirror it.
      try {
        await getAdmin()
          .updateTable('cdn_api_keys')
          .set({ last_used_at: new Date().toISOString() })
          .where('id', '=', keyId)
          .execute()
      }
      catch {
        // parity: swallowed
      }
    },

    async countActiveCDNKeys(projectId) {
      try {
        const row = await getAdmin()
          .selectFrom('cdn_api_keys')
          .select(eb => eb.fn.countAll().as('count'))
          .where('project_id', '=', projectId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst()

        return Number(row?.count ?? 0)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createCDNKey(input) {
      try {
        const row = await getAdmin()
          .insertInto('cdn_api_keys')
          .values({
            project_id: input.projectId,
            workspace_id: input.workspaceId,
            key_hash: input.keyHash,
            key_prefix: input.keyPrefix,
            name: input.name,
            scopes: input.scopes ?? ['delivery'],
          })
          .returning(['id', 'name', 'key_prefix', 'environment', 'scopes', 'created_at'])
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row as DatabaseRow
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createCDNKeyIfAllowed(input) {
      let result: { allowed: boolean, current_count: number, key?: Record<string, unknown> }
      try {
        const outcome = await sql<{ result: typeof result }>`
          SELECT public.create_cdn_key_if_allowed(
            p_project_id => ${input.projectId},
            p_workspace_id => ${input.workspaceId},
            p_key_hash => ${input.keyHash},
            p_key_prefix => ${input.keyPrefix},
            p_name => ${input.name},
            p_limit => ${input.limit},
            p_scopes => ${input.scopes ?? ['delivery']}
          ) AS result
        `.execute(getAdmin())

        result = outcome.rows[0]!.result
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Atomic CDN key check failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }

      if (!result.allowed)
        return { allowed: false, currentCount: result.current_count }

      return {
        allowed: true,
        currentCount: result.current_count,
        key: (result.key ?? undefined) as DatabaseRow | undefined,
      }
    },

    async getCDNKey(keyId) {
      try {
        const row = await getAdmin()
          .selectFrom('cdn_api_keys')
          .select(['id', 'name', 'key_prefix', 'environment', 'rate_limit_per_hour', 'allowed_origins', 'last_used_at', 'expires_at', 'created_at', 'revoked_at'])
          .where('id', '=', keyId)
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listCDNKeys(accessToken, projectId, _workspaceId) {
      try {
        return await withUser(accessToken, async trx =>
          await trx
            .selectFrom('cdn_api_keys')
            .select(['id', 'name', 'key_prefix', 'environment', 'scopes', 'rate_limit_per_hour', 'last_used_at', 'expires_at', 'created_at', 'revoked_at'])
            .where('project_id', '=', projectId)
            .execute() as DatabaseRow[])
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async revokeCDNKey(keyId, projectId) {
      try {
        await getAdmin()
          .updateTable('cdn_api_keys')
          .set({ revoked_at: new Date().toISOString() })
          .where('id', '=', keyId)
          .where('project_id', '=', projectId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createCDNBuild(input) {
      try {
        // Atomic single-in-flight claim (per-project advisory lock + stale
        // reclaim). Returns the new id, or NULL when a build is already running.
        const outcome = await sql<{ result: string | null }>`
          SELECT public.claim_cdn_build(
            p_project_id => ${input.projectId}::uuid,
            p_trigger_type => ${input.triggerType},
            p_commit_sha => ${input.commitSha ?? null},
            p_branch => ${input.branch ?? null},
            p_stale_seconds => 900
          ) AS result
        `.execute(getAdmin())

        const id = outcome.rows[0]?.result ?? null
        return id ? ({ id } as DatabaseRow) : null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateCDNBuild(buildId, updates) {
      try {
        await getAdmin()
          .updateTable('cdn_builds')
          .set(updates as never)
          .where('id', '=', buildId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listCDNBuilds(projectId, options) {
      const limit = options?.limit ?? 20
      const page = options?.page ?? 1
      const offset = (page - 1) * limit

      try {
        return await getAdmin()
          .selectFrom('cdn_builds')
          .select(['id', 'trigger_type', 'commit_sha', 'branch', 'status', 'file_count', 'total_size_bytes', 'changed_models', 'build_duration_ms', 'error_message', 'started_at', 'completed_at'])
          .where('project_id', '=', projectId)
          .orderBy('started_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async incrementCDNUsage(projectId, apiKeyId, periodStart, requestCount, bandwidthBytes) {
      try {
        await sql`
          SELECT public.increment_cdn_usage(
            p_project_id => ${projectId},
            p_api_key_id => ${apiKeyId},
            p_period_start => ${periodStart},
            p_request_count => ${requestCount},
            p_bandwidth_bytes => ${bandwidthBytes}
          )
        `.execute(getAdmin())
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `CDN usage increment failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async incrementPublicCDNUsage(projectId, periodStart, requestCount, bandwidthBytes) {
      try {
        await sql`
          SELECT public.increment_cdn_usage_public(
            p_project_id => ${projectId},
            p_period_start => ${periodStart},
            p_request_count => ${requestCount},
            p_bandwidth_bytes => ${bandwidthBytes}
          )
        `.execute(getAdmin())
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Public CDN usage increment failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async getMonthlyProjectCDNUsage(projectId, startDate, endDate) {
      // Failure reads as zero totals (the Supabase impl never checks the error).
      try {
        const row = await getAdmin()
          .selectFrom('cdn_usage')
          .select(eb => [
            eb.fn.coalesce(eb.fn.sum('request_count'), eb.lit(0)).as('request_count'),
            eb.fn.coalesce(eb.fn.sum('bandwidth_bytes'), eb.lit(0)).as('bandwidth_bytes'),
          ])
          .where('project_id', '=', projectId)
          .where('period_start', '>=', startDate)
          .where('period_start', '<=', endDate)
          .executeTakeFirst()

        return {
          requestCount: Number(row?.request_count ?? 0),
          bandwidthBytes: Number(row?.bandwidth_bytes ?? 0),
        }
      }
      catch {
        return { requestCount: 0, bandwidthBytes: 0 }
      }
    },

    // Conversation key validation (shared with CDN pattern)
    async validateConversationKeyHash(keyHash) {
      try {
        const row = await getAdmin()
          .selectFrom('conversation_api_keys')
          .select(['id', 'project_id', 'workspace_id', 'name', 'role', 'specific_models', 'allowed_models', 'allowed_tools', 'allowed_locales', 'custom_instructions', 'ai_model', 'rate_limit_per_minute', 'monthly_message_limit', 'revoked_at'])
          .where('key_hash', '=', keyHash)
          .where('revoked_at', 'is', null)
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch {
        return null
      }
    },

    async updateConversationKeyLastUsed(keyId) {
      try {
        await getAdmin()
          .updateTable('conversation_api_keys')
          .set({ last_used_at: new Date().toISOString() })
          .where('id', '=', keyId)
          .execute()
      }
      catch {
        // parity: swallowed
      }
    },
  }
}
