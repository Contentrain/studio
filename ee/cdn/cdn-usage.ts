/**
 * CDN usage metering — tracks requests and bandwidth per API key.
 *
 * Called on every CDN request to accumulate daily usage.
 * Aggregates into cdn_usage table (daily per project + key).
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

export async function trackCDNUsage(
  projectId: string,
  apiKeyId: string,
  responseSizeBytes: number,
): Promise<void> {
  const today = new Date().toISOString().substring(0, 10)
  await useDatabaseProvider().incrementCDNUsage(projectId, apiKeyId, today, 1, responseSizeBytes)
}

/**
 * Get monthly usage for a project.
 */
export async function getMonthlyUsage(
  projectId: string,
  month?: string,
): Promise<{ requestCount: number, bandwidthBytes: number }> {
  const targetMonth = month ?? new Date().toISOString().substring(0, 7)
  const startDate = `${targetMonth}-01`
  const endDate = `${targetMonth}-31`
  return useDatabaseProvider().getMonthlyProjectCDNUsage(projectId, startDate, endDate)
}
