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
 * - The cancellation reaches the billing webhook as `subscription.canceled`, which
 *   drops the workspace plan the usual way.
 */
import type { MigrateRevokeReason, MigrateRevokeResponse } from '@contentrain/types'
import { validateMigrateRevokeResponse } from '@contentrain/types'
import type { DatabaseRow } from '../providers/database'
import { migrateGrantInstallation } from './migrate-grant-status'

export async function revokeMigrateGrant(grant: DatabaseRow, reason: MigrateRevokeReason): Promise<MigrateRevokeResponse> {
  const db = useDatabaseProvider()
  const { installed } = await migrateGrantInstallation(grant)

  let canceled = false
  if (!grant.revoked_at) {
    const subscriptionId = grant.redeemed_subscription_id as string | null
    if (subscriptionId) {
      const payment = usePaymentProvider()
      if (!payment) throw createError({ statusCode: 503, message: errorMessage('generic.server_error') })
      try {
        await payment.cancelSubscription(subscriptionId)
        canceled = true
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
