/**
 * Usage metering facade.
 *
 * Thin wrapper around `DatabaseProvider.enqueueUsageEvent` that writes
 * each usage event to `usage_events_outbox`. A background drain cron
 * dispatches outbox rows to the active `PaymentProvider.ingestUsageEvent`.
 *
 * Call sites in the agent, form submit handler, CDN aggregator, MCP
 * tool exec, and media storage cron use these typed helpers so the
 * meter names stay consistent with the Polar meter slugs defined in
 * `shared/utils/usage-meters.ts`.
 *
 * Recording is best-effort: outbox enqueue failures are logged and
 * swallowed so the triggering user action (send AI message, submit
 * form, etc.) is never blocked on billing plumbing.
 */

import { USAGE_METERS } from '../../shared/utils/usage-meters'
import { isBillingConfigured } from './license'

async function recordUsage(input: {
  workspaceId: string
  meterName: string
  value: number
  idempotencyKey: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  // No billing configured → no outbox writes. Self-hosted deployments
  // don't meter; their plan limits are enforced via middleware only.
  if (!isBillingConfigured()) return

  try {
    const db = useDatabaseProvider()
    await db.enqueueUsageEvent({
      workspaceId: input.workspaceId,
      meterName: input.meterName,
      value: input.value,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    })
  }
  catch (err) {
    // eslint-disable-next-line no-console -- best-effort metering; log without blocking caller
    console.error('[usage-metering] Failed to enqueue usage event:', err)
  }
}

export function recordAIUsage(input: {
  workspaceId: string
  count: number
  userId: string
  month: string
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.AI_MESSAGES.name,
    value: input.count,
    idempotencyKey: `ai:${input.workspaceId}:${input.userId}:${input.month}:${Date.now()}`,
    metadata: { source: 'studio', user_id: input.userId, month: input.month },
  })
}

export function recordAPIUsage(input: {
  workspaceId: string
  count: number
  apiKeyId: string
  month: string
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.API_MESSAGES.name,
    value: input.count,
    idempotencyKey: `api:${input.workspaceId}:${input.apiKeyId}:${input.month}:${Date.now()}`,
    metadata: { source: 'api', api_key_id: input.apiKeyId, month: input.month },
  })
}

export function recordMCPCallUsage(input: {
  workspaceId: string
  count: number
  keyId: string
  month: string
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.MCP_CALLS.name,
    value: input.count,
    idempotencyKey: `mcp:${input.workspaceId}:${input.keyId}:${input.month}:${Date.now()}`,
    metadata: { key_id: input.keyId, month: input.month },
  })
}

export function recordFormSubmissionUsage(input: {
  workspaceId: string
  submissionId: string
  modelId: string
  projectId: string
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.FORM_SUBMISSIONS.name,
    value: 1,
    idempotencyKey: `form:${input.submissionId}`,
    metadata: { submission_id: input.submissionId, model_id: input.modelId, project_id: input.projectId },
  })
}

export function recordCDNBandwidthUsage(input: {
  workspaceId: string
  bytes: number
  projectId: string
  usageRowId: string
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.CDN_BANDWIDTH_BYTES.name,
    value: input.bytes,
    idempotencyKey: `cdn:${input.usageRowId}`,
    metadata: { project_id: input.projectId, usage_row_id: input.usageRowId },
  })
}

export function recordStorageSample(input: {
  workspaceId: string
  byteHours: number
  sampleHour: string
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.MEDIA_STORAGE_BYTE_HOURS.name,
    value: input.byteHours,
    idempotencyKey: `storage:${input.workspaceId}:${input.sampleHour}`,
    metadata: { sample_hour: input.sampleHour },
  })
}
