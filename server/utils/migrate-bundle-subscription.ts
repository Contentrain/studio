/**
 * The second half of a "Migrate with Studio" bundle: moving its subscription
 * from the ad-hoc priced bundle product to the plan's yearly list product.
 *
 * The first invoice rides on a price Studio set for one checkout. Polar keeps
 * that price on the subscription, so if the move never happens the renewal
 * charges it again (verified in sandbox 2026-10-03: ad-hoc $5 carried forever,
 * a `next_period` product change gave the list price at renewal). So:
 *
 * - the billing webhook moves it as soon as the subscription exists;
 * - a failed move is never silent: the grant keeps `bundle_applied_at` NULL and
 *   a scheduled job retries it;
 * - a subscription still not moved 30 days before its renewal raises an alarm
 *   (an error-level log line `[migrate-bundle] ALARM`, which the platform's log
 *   alert watches), because from then on the customer is about to be charged the
 *   wrong amount.
 */
import type { DatabaseRow } from '../providers/database'
import type { PaymentProvider } from '../providers/payment/types'

export const BUNDLE_ALARM_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export type BundleMoveResult = 'applied' | 'pending' | 'skipped'

/** Move one grant's subscription to the list product; never throws (a failure leaves the grant pending). */
export async function applyBundleListProduct(
  payment: PaymentProvider,
  grant: DatabaseRow,
  subscriptionId: string,
): Promise<BundleMoveResult> {
  if (grant.kind !== 'bundle' || !grant.bundle_target_product_id || grant.bundle_applied_at) return 'skipped'
  const db = useDatabaseProvider()
  try {
    await payment.moveBundleSubscriptionToList(subscriptionId, grant.plan as 'starter' | 'pro')
    await db.markMigrateBundleApplied(String(grant.id))
    return 'applied'
  }
  catch (err) {
    // eslint-disable-next-line no-console -- ops visibility: the reconciler retries
    console.error(`[migrate-bundle] move to list product failed for grant ${String(grant.id)}, subscription ${subscriptionId}:`, err)
    return 'pending'
  }
}

export interface BundleReconcileSummary {
  checked: number
  applied: number
  stillPending: number
  alarms: number
}

/** Retry every pending move and raise the alarm for those too close to renewal. */
export async function reconcileMigrateBundles(payment: PaymentProvider, now: Date = new Date()): Promise<BundleReconcileSummary> {
  const db = useDatabaseProvider()
  const pending = await db.listPendingMigrateBundles(100)
  const summary: BundleReconcileSummary = { checked: pending.length, applied: 0, stillPending: 0, alarms: 0 }
  for (const grant of pending) {
    const subscriptionId = grant.redeemed_subscription_id as string | null
    if (!subscriptionId) continue
    const result = await applyBundleListProduct(payment, grant, subscriptionId)
    if (result === 'applied') {
      summary.applied++
      continue
    }
    summary.stillPending++
    const account = grant.workspace_id ? await db.getActivePaymentAccount(String(grant.workspace_id)) : null
    const renewsAt = account?.current_period_end ? new Date(String(account.current_period_end)) : null
    // Unknown renewal date: alarm anyway, an unmoved subscription with no date is not safe to leave.
    if (!renewsAt || renewsAt.getTime() - now.getTime() <= BUNDLE_ALARM_DAYS * DAY_MS) {
      summary.alarms++
      // eslint-disable-next-line no-console -- the alarm: watched by the platform's log alert
      console.error(`[migrate-bundle] ALARM grant ${String(grant.id)} (subscription ${subscriptionId}) is still on the ad-hoc price; renews ${renewsAt?.toISOString() ?? 'at an unknown date'}`)
    }
  }
  return summary
}

/**
 * A subscription started from a Migrate grant's checkout uses the grant up
 * (no second included trial after cancel-and-resubscribe), and a bundle
 * grant's subscription moves to its list product. Idempotent: whichever of
 * `subscription.created` / `.updated` arrives first does the work.
 */
export async function redeemMigrateGrant(payment: PaymentProvider, grantId: string, subscriptionId: string | null): Promise<void> {
  const db = useDatabaseProvider()
  await db.markMigrateGrantRedeemed(grantId, subscriptionId)
  if (!subscriptionId) return
  const grant = await db.getMigrateGrantById(grantId)
  if (grant) await applyBundleListProduct(payment, grant, subscriptionId)
}
