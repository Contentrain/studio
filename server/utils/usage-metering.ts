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
 * Recording is best-effort: an outbox enqueue failure never blocks the
 * triggering user action (send AI message, submit form, etc.). It is
 * not silent either: a lost event is usage the payment provider never
 * bills, so it goes to `reportBillingRisk` (log + Sentry) with the
 * meter, value and idempotency key needed to replay it by hand.
 */

import { USAGE_METERS } from '../../shared/utils/usage-meters'
import { creditTermsFor } from '../../shared/utils/credit-unit'
import type { CreditUnit } from '../../shared/utils/credit-unit'
import { reportBillingRisk } from './alert'
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
    reportBillingRisk(err, {
      op: 'usage-metering.enqueue',
      workspaceId: input.workspaceId,
      meterName: input.meterName,
      value: input.value,
      idempotencyKey: input.idempotencyKey,
    })
  }
}

/**
 * Studio-funded AI credits only. A BYOA turn runs on the user's own
 * Anthropic key and must never reach this meter — the chat route skips
 * the call for it — which is why `source` is fixed to `studio` here.
 */
export function recordAIUsage(input: {
  workspaceId: string
  count: number
  userId: string
  month: string
  /** The account's credit unit — picks the meter its subscription is priced on. */
  creditUnit: CreditUnit
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: creditTermsFor(input.creditUnit).meters.ai,
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
  /** The account's credit unit — picks the meter its subscription is priced on. */
  creditUnit: CreditUnit
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: creditTermsFor(input.creditUnit).meters.api,
    value: input.count,
    idempotencyKey: `api:${input.workspaceId}:${input.apiKeyId}:${input.month}:${Date.now()}`,
    metadata: { source: 'api', api_key_id: input.apiKeyId, month: input.month },
  })
}

export function recordMCPCallUsage(input: {
  workspaceId: string
  count: number
  /** Metering identity: an mcp_cloud_keys id (key surface) or an oauth grant id (remote surface). */
  keyId: string
  month: string
  source?: 'key' | 'grant'
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.MCP_CALLS.name,
    value: input.count,
    idempotencyKey: `mcp:${input.workspaceId}:${input.keyId}:${input.month}:${Date.now()}`,
    metadata: { key_id: input.keyId, month: input.month, source: input.source ?? 'key' },
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

/**
 * One day of CDN origin transfer for a workspace, in GB (`cdn_origin_gb`).
 * Keyed by workspace + day, so a job re-running for the same day records
 * nothing twice.
 */
export function recordCDNOriginUsage(input: {
  workspaceId: string
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  bytes: number
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.CDN_ORIGIN_GB.name,
    value: Math.round((input.bytes / 1024 ** 3) * 1e6) / 1e6,
    idempotencyKey: `cdn-origin:${input.workspaceId}:${input.day}`,
    metadata: { day: input.day, bytes: input.bytes },
  })
}

/** A gigabyte-month in GB per day: the day's stored GB over the days in its period, rounded to 1e-6. */
export function storageGbMonthsForDay(bytes: number, periodDays: number): number {
  if (bytes <= 0 || periodDays <= 0) return 0
  return Math.round((bytes / 1024 ** 3 / periodDays) * 1e6) / 1e6
}

/**
 * One day of media storage for a workspace, in GB-months
 * (`media_storage_gb_months`): the GB stored at the day's sample divided by
 * the days in the workspace's billing period, so a full period sums to the
 * average GB stored over it. Keyed by workspace + day, so a job re-running
 * for the same day records nothing twice.
 */
export function recordMediaStorageDay(input: {
  workspaceId: string
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  bytes: number
  /** Days in the billing (or calendar) period the day belongs to. */
  periodDays: number
}): Promise<void> {
  return recordUsage({
    workspaceId: input.workspaceId,
    meterName: USAGE_METERS.MEDIA_STORAGE_GB_MONTHS.name,
    value: storageGbMonthsForDay(input.bytes, input.periodDays),
    idempotencyKey: `storage-gbm:${input.workspaceId}:${input.day}`,
    metadata: { day: input.day, bytes: input.bytes, period_days: input.periodDays },
  })
}
