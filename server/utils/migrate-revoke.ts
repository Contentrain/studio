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
    await db.markMigrateGrantRevoked(String(grant.id), reason)
  }

  const response: MigrateRevokeResponse = { state: 'revoked', installed, subscription_canceled: canceled }
  // Fail closed on our own answer: Migrate acts on it.
  if (!validateMigrateRevokeResponse(response).ok)
    throw createError({ statusCode: 500, message: errorMessage('migrate.s2s_invalid') })
  return response
}
