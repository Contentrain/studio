/**
 * CDN key, build, and usage methods for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, getUser, toDatabaseRowOrNull } from './helpers'

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
  | 'getMonthlyProjectCDNUsage'
  | 'validateConversationKeyHash'
  | 'updateConversationKeyLastUsed'
>

export function cdnMethods(): CDNMethods {
  return {
    async validateCDNKeyHash(keyHash) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('cdn_api_keys')
        .select('id, project_id, rate_limit_per_hour, allowed_origins, revoked_at, expires_at')
        .eq('key_hash', keyHash)
        .is('revoked_at', null)
        .single()

      if (error) return null
      return toDatabaseRowOrNull(data)
    },

    async updateCDNKeyLastUsed(keyId) {
      await getAdmin()
        .from('cdn_api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyId)
    },

    async countActiveCDNKeys(projectId) {
      const { count, error } = await getAdmin()
        .from('cdn_api_keys')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .is('revoked_at', null)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return count ?? 0
    },

    async createCDNKey(input) {
      const { data, error } = await getAdmin()
        .from('cdn_api_keys')
        .insert({
          project_id: input.projectId,
          workspace_id: input.workspaceId,
          key_hash: input.keyHash,
          key_prefix: input.keyPrefix,
          name: input.name,
        })
        .select('id, name, key_prefix, environment, created_at')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async createCDNKeyIfAllowed(input) {
      const admin = getAdmin()
      const { data, error } = await admin.rpc('create_cdn_key_if_allowed', {
        p_project_id: input.projectId,
        p_workspace_id: input.workspaceId,
        p_key_hash: input.keyHash,
        p_key_prefix: input.keyPrefix,
        p_name: input.name,
        p_limit: input.limit,
      })

      if (error) {
        throw createError({ statusCode: 500, message: `Atomic CDN key check failed: ${error.message}` })
      }

      const result = data as { allowed: boolean, current_count: number, key?: Record<string, unknown> }

      if (!result.allowed) {
        return { allowed: false, currentCount: result.current_count }
      }

      return {
        allowed: true,
        currentCount: result.current_count,
        key: (result.key ?? undefined) as import('../database').DatabaseRow | undefined,
      }
    },

    async getCDNKey(keyId) {
      const { data, error } = await getAdmin()
        .from('cdn_api_keys')
        .select('id, name, key_prefix, environment, rate_limit_per_hour, allowed_origins, last_used_at, expires_at, created_at, revoked_at')
        .eq('id', keyId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }
      return toDatabaseRowOrNull(data)
    },

    async listCDNKeys(accessToken, projectId, _workspaceId) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('cdn_api_keys')
        .select('id, name, key_prefix, environment, rate_limit_per_hour, last_used_at, expires_at, created_at, revoked_at')
        .eq('project_id', projectId)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async revokeCDNKey(keyId, projectId) {
      const { error } = await getAdmin()
        .from('cdn_api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', keyId)
        .eq('project_id', projectId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async createCDNBuild(input) {
      const { data, error } = await getAdmin()
        .from('cdn_builds')
        .insert({
          project_id: input.projectId,
          trigger_type: input.triggerType,
          commit_sha: input.commitSha ?? null,
          branch: input.branch ?? null,
          status: 'building',
        })
        .select('id')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async updateCDNBuild(buildId, updates) {
      const { error } = await getAdmin()
        .from('cdn_builds')
        .update(updates)
        .eq('id', buildId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async listCDNBuilds(projectId, options) {
      const limit = options?.limit ?? 20
      const page = options?.page ?? 1
      const offset = (page - 1) * limit

      const { data, error } = await getAdmin()
        .from('cdn_builds')
        .select('id, trigger_type, commit_sha, branch, status, file_count, total_size_bytes, changed_models, build_duration_ms, error_message, started_at, completed_at')
        .eq('project_id', projectId)
        .order('started_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async incrementCDNUsage(projectId, apiKeyId, periodStart, requestCount, bandwidthBytes) {
      const admin = getAdmin()
      const { error } = await admin.rpc('increment_cdn_usage', {
        p_project_id: projectId,
        p_api_key_id: apiKeyId,
        p_period_start: periodStart,
        p_request_count: requestCount,
        p_bandwidth_bytes: bandwidthBytes,
      })
      if (error) {
        throw createError({ statusCode: 500, message: `CDN usage increment failed: ${error.message}` })
      }
    },

    async getMonthlyProjectCDNUsage(projectId, startDate, endDate) {
      const { data } = await getAdmin()
        .from('cdn_usage')
        .select('request_count, bandwidth_bytes')
        .eq('project_id', projectId)
        .gte('period_start', startDate)
        .lte('period_start', endDate)

      const totals = (data ?? []).reduce(
        (acc: { requestCount: number, bandwidthBytes: number }, row: Record<string, unknown>) => ({
          requestCount: acc.requestCount + ((row.request_count as number) ?? 0),
          bandwidthBytes: acc.bandwidthBytes + ((row.bandwidth_bytes as number) ?? 0),
        }),
        { requestCount: 0, bandwidthBytes: 0 },
      )

      return totals
    },

    // Conversation key validation (shared with CDN pattern)
    async validateConversationKeyHash(keyHash) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('conversation_api_keys')
        .select('id, project_id, workspace_id, name, role, specific_models, allowed_models, allowed_tools, allowed_locales, custom_instructions, ai_model, rate_limit_per_minute, monthly_message_limit, revoked_at')
        .eq('key_hash', keyHash)
        .is('revoked_at', null)
        .single()

      if (error) return null
      return toDatabaseRowOrNull(data)
    },

    async updateConversationKeyLastUsed(keyId) {
      await getAdmin()
        .from('conversation_api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyId)
    },
  }
}
