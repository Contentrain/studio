/**
 * Withdraw a Migrate grant (`POST /api/migrate/grants/revoke`): Migrate's half of a
 * refund or a failed delivery. The money is refunded in Polar by an operator; this
 * stops Studio from continuing a year nobody pays for.
 *
 * - Only the subscription the grant is BOUND to (`redeemed_subscription_id`) is
 *   cancelled. A second payment that came from a stale checkout never became the
 *   grant's subscription (see `isDuplicateBundleSubscription`): its refund is a
 *   Polar-side matter and must not revoke the grant, so nothing here reads it.
 * - The cancel happens before the grant is marked, so a Polar failure leaves the
 *   grant live and Migrate can call again (idempotent). A repeated call on a
 *   revoked grant answers `revoked` and cancels nothing.
 * - The plan's monthly usage subscription (the companion of a yearly plan) is cancelled first, with the
 *   same retry rule: cancelling the plan alone would leave it billing usage to a customer with no plan.
 * - The cancellation reaches the billing webhook as `subscription.canceled`, which
 *   drops the workspace plan the usual way.
 * - A Studio year Migrate collected (`collector='migrate'`, migration 055) has no
 *   subscription: its prepaid year ends on the workspace now, the way an ended
 *   subscription leaves it (plan `free` unless a subscription of its own runs there).
 *   Only the year this grant started is taken off, and before the grant is marked,
 *   so a failure leaves the grant live and Migrate calls again.
 */
import type { MigrateRevokeReason, MigrateRevokeResponse } from '@contentrain/types'
import { validateMigrateRevokeResponse } from '@contentrain/types'
import type { DatabaseRow } from '../providers/database'
import { migrateGrantInstallation } from './migrate-grant-status'
import { cancelCompanionSubscription } from './companion-subscription'

export async function revokeMigrateGrant(grant: DatabaseRow, reason: MigrateRevokeReason): Promise<MigrateRevokeResponse> {
  const db = useDatabaseProvider()
  const { installed } = await migrateGrantInstallation(grant)

  let canceled = false
  if (!grant.revoked_at) {
    const subscriptionId = grant.redeemed_subscription_id as string | null
    if (subscriptionId) {
      const payment = usePaymentProvider()
      if (!payment) throw createError({ statusCode: 503, message: errorMessage('generic.server_error') })
      // Read before anything is cancelled: the webhook archives the account when the plan subscription ends.
      const account = grant.workspace_id ? await db.getActivePaymentAccount(String(grant.workspace_id)) : null
      try {
        await cancelCompanionSubscription(payment, account?.plugin_metadata, `revoke of grant ${String(grant.id)}`, true)
        // An already ended subscription is the goal met, not a failure: the grant is still marked below.
        canceled = (await payment.cancelSubscription(subscriptionId)) === 'canceled'
      }
      catch (err) {
        // eslint-disable-next-line no-console -- ops visibility: Migrate retries the call
        console.error(`[migrate-revoke] cancelling subscription ${subscriptionId} for grant ${String(grant.id)} failed:`, err)
        throw createError({ statusCode: 502, message: errorMessage('billing.provider_unavailable') })
      }
    }
    // Ended before the mark, so a failure here leaves the grant live and Migrate's retry finishes it.
    if (isPrepaidGrant(grant)) await endPrepaidYear(String(grant.workspace_id), grant.prepaid_ends_at)
    const fresh = await db.markMigrateGrantRevoked(String(grant.id), reason)
    // An activate that ran after this route read the grant started a year the row above did not carry: the
    // revoked row is the fresh one, so end that year too. A second call is a no-op (it matches the year's end).
    if (fresh && isPrepaidGrant(fresh)) await endPrepaidYear(String(fresh.workspace_id), fresh.prepaid_ends_at)
  }

  const response: MigrateRevokeResponse = { state: 'revoked', installed, subscription_canceled: canceled }
  // Fail closed on our own answer: Migrate acts on it.
  if (!validateMigrateRevokeResponse(response).ok)
    throw createError({ statusCode: 500, message: errorMessage('migrate.s2s_invalid') })
  return response
}

const isPrepaidGrant = (grant: Record<string, unknown>): boolean => grant.collector === 'migrate' && Boolean(grant.prepaid_ends_at) && Boolean(grant.workspace_id)

/** Take a grant's prepaid year off its workspace: only when the workspace still holds that year. */
async function endPrepaidYear(workspaceId: string, grantEndsAt: unknown): Promise<void> {
  const db = useDatabaseProvider()
  const workspace = await db.getWorkspaceById(workspaceId, 'id, prepaid_until')
  if (!workspace?.prepaid_until) return
  if (new Date(workspace.prepaid_until as string).getTime() !== new Date(grantEndsAt as string).getTime()) return
  const account = await db.getActivePaymentAccount(workspaceId)
  await db.updateWorkspace('', workspaceId, {
    prepaid_until: null,
    prepaid_plan: null,
    // A subscription of the workspace's own keeps its plan; without one it falls back like an ended subscription.
    ...(account?.subscription_id ? {} : { plan: 'free', trial_reminder_stage: 0 }),
  })
}
