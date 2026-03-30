/**
 * CDN usage metering — tracks requests and bandwidth per API key.
 *
 * Called on every CDN request to accumulate daily usage.
 * Aggregates into cdn_usage table (daily per project + key).
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export async function trackCDNUsage(
  admin: SupabaseClient,
  projectId: string,
  apiKeyId: string,
  responseSizeBytes: number,
): Promise<void> {
  const today = new Date().toISOString().substring(0, 10) // YYYY-MM-DD

  // Upsert daily usage — increment counts via RPC
  const { error: rpcError } = await admin.rpc('increment_cdn_usage', {
    p_project_id: projectId,
    p_api_key_id: apiKeyId,
    p_period_start: today,
    p_request_count: 1,
    p_bandwidth_bytes: responseSizeBytes,
  })

  if (rpcError) {
    // Fallback: read-then-update if RPC doesn't exist
    const { data: existing } = await admin
      .from('cdn_usage')
      .select('id, request_count, bandwidth_bytes')
      .eq('project_id', projectId)
      .eq('api_key_id', apiKeyId)
      .eq('period_start', today)
      .single()

    if (existing) {
      await admin.from('cdn_usage').update({
        request_count: (existing.request_count ?? 0) + 1,
        bandwidth_bytes: (existing.bandwidth_bytes ?? 0) + responseSizeBytes,
      }).eq('id', existing.id)
    }
    else {
      await admin.from('cdn_usage').insert({
        project_id: projectId,
        api_key_id: apiKeyId,
        period_start: today,
        request_count: 1,
        bandwidth_bytes: responseSizeBytes,
      })
    }
  }
}

/**
 * Get monthly usage for a project.
 */
export async function getMonthlyUsage(
  admin: SupabaseClient,
  projectId: string,
  month?: string,
): Promise<{ requestCount: number, bandwidthBytes: number }> {
  const targetMonth = month ?? new Date().toISOString().substring(0, 7) // YYYY-MM
  const startDate = `${targetMonth}-01`
  const endDate = `${targetMonth}-31` // Simplified — includes all days

  const { data } = await admin
    .from('cdn_usage')
    .select('request_count, bandwidth_bytes')
    .eq('project_id', projectId)
    .gte('period_start', startDate)
    .lte('period_start', endDate)

  const totals = (data ?? []).reduce(
    (acc, row) => ({
      requestCount: acc.requestCount + (row.request_count ?? 0),
      bandwidthBytes: acc.bandwidthBytes + (row.bandwidth_bytes ?? 0),
    }),
    { requestCount: 0, bandwidthBytes: 0 },
  )

  return totals
}
