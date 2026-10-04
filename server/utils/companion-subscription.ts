/**
 * The monthly usage subscription opened beside a yearly plan.
 *
 * Polar invoices metered usage on a subscription's own cycle, so overage on a
 * yearly subscription alone would be billed once a year. The founder's rule is
 * that usage and overage are monthly whatever the billing frequency. A companion
 * is a second subscription for the same customer on a $0-base monthly product
 * that carries the plan's metered prices and monthly meter credits; the plan
 * subscription keeps the fixed yearly fee. Verified in the Polar sandbox
 * (2026-10-05): a free-plus-metered monthly product accepts `subscriptions.create`
 * with no checkout, grants its meter credit, and counts overage against it.
 * NOT verified: that the overage invoice is charged to the card saved at the
 * yearly checkout (see the PR's open questions).
 *
 * Isolation: a companion's events never write the account's subscription
 * fields. The webhook records two keys in `plugin_metadata` through
 * `setPaymentAccountMetadataKey` (the companion's id and the meters it prices),
 * which the plan subscription's own writes preserve.
 *
 * Everything here is best effort and silent when companions are off (the
 * provider returns null): a failure never fails the plan subscription's webhook,
 * it is logged as an ALARM and the reconciler retries.
 */
import type { DatabaseProvider, DatabaseRow } from '../providers/database'
import type { PaymentProvider } from '../providers/payment/types'
import { COMPANION_SUBSCRIPTION_KEY, isYearlyPeriod } from './overage-lock'

type Db = Pick<DatabaseProvider, 'setPaymentAccountMetadataKey'>

/** The companion's subscription id stored on an account, or null. */
export function companionSubscriptionIdOf(pluginMetadata: unknown): string | null {
  if (!pluginMetadata || typeof pluginMetadata !== 'object') return null
  const id = (pluginMetadata as Record<string, unknown>)[COMPANION_SUBSCRIPTION_KEY]
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Open (or find) the companion for a plan subscription and record it on the account. Never throws. */
export async function openCompanionSubscription(
  provider: PaymentProvider,
  db: Db,
  input: { workspaceId: string, plan: string | null | undefined, customerId: string, subscriptionId: string | null | undefined, productId: string | null | undefined },
): Promise<void> {
  if (!provider.ensureCompanionSubscription) return
  if ((input.plan !== 'starter' && input.plan !== 'pro') || !input.subscriptionId) return
  try {
    const companion = await provider.ensureCompanionSubscription({
      workspaceId: input.workspaceId,
      plan: input.plan,
      customerId: input.customerId,
      parentSubscriptionId: input.subscriptionId,
      ...(input.productId ? { parentProductId: input.productId } : {}),
    })
    if (!companion) return
    await db.setPaymentAccountMetadataKey({ workspaceId: input.workspaceId, key: COMPANION_SUBSCRIPTION_KEY, value: companion.subscriptionId, when: 'different' })
  }
  catch (err) {
    // eslint-disable-next-line no-console -- the alarm: watched by the platform's log alert; the reconciler retries
    console.error(`[companion] ALARM could not open the usage subscription for workspace ${input.workspaceId} (plan subscription ${input.subscriptionId}):`, err)
  }
}

/**
 * Cancel the companion recorded on an account. `throwOnFailure` is for callers that retry (revoke): there a
 * failure must leave the grant live. Elsewhere it is logged, since the plan subscription's end matters more.
 */
export async function cancelCompanionSubscription(
  provider: PaymentProvider,
  pluginMetadata: unknown,
  context: string,
  throwOnFailure = false,
): Promise<boolean> {
  const id = companionSubscriptionIdOf(pluginMetadata)
  if (!id) return false
  try {
    return (await provider.cancelSubscription(id)) === 'canceled'
  }
  catch (err) {
    // eslint-disable-next-line no-console -- the alarm: an uncancelled companion keeps billing usage to a customer with no plan
    console.error(`[companion] ALARM could not cancel usage subscription ${id} (${context}):`, err)
    if (throwOnFailure) throw err
    return false
  }
}

export interface CompanionReconcileSummary {
  checked: number
  opened: number
  failed: number
}

/** Yearly plan accounts that have no companion yet: the ones the reconciler opens one for. */
export function accountsMissingCompanion(rows: DatabaseRow[]): DatabaseRow[] {
  return rows.filter(row =>
    row.subscription_status === 'active'
    && Boolean(row.subscription_id) && Boolean(row.customer_id)
    && isYearlyPeriod({ current_period_start: row.current_period_start as string | null, current_period_end: row.current_period_end as string | null })
    && !companionSubscriptionIdOf(row.plugin_metadata),
  )
}

/**
 * Open the companion for every active yearly plan that lacks one (a webhook that failed to open it, or a
 * subscription that predates the flag). The provider decides whether the account's product gets one at all.
 */
export async function reconcileCompanionSubscriptions(
  provider: PaymentProvider,
  db: Db & Pick<DatabaseProvider, 'listActivePaymentAccounts'>,
  providerKey: string,
): Promise<CompanionReconcileSummary> {
  const summary: CompanionReconcileSummary = { checked: 0, opened: 0, failed: 0 }
  if (!provider.ensureCompanionSubscription) return summary
  for (const row of accountsMissingCompanion(await db.listActivePaymentAccounts(providerKey, 500))) {
    summary.checked++
    const workspaceId = String(row.workspace_id)
    try {
      // The account does not store the plan subscription's product: the provider reads it from the subscription.
      const companion = await provider.ensureCompanionSubscription({
        workspaceId,
        plan: row.plan === 'pro' ? 'pro' : 'starter',
        customerId: String(row.customer_id),
        parentSubscriptionId: String(row.subscription_id),
      })
      if (!companion) continue
      await db.setPaymentAccountMetadataKey({ workspaceId, key: COMPANION_SUBSCRIPTION_KEY, value: companion.subscriptionId, when: 'different' })
      if (companion.created) summary.opened++
    }
    catch (err) {
      summary.failed++
      // eslint-disable-next-line no-console -- the alarm: watched by the platform's log alert
      console.error(`[companion] ALARM reconcile could not open the usage subscription for workspace ${workspaceId}:`, err)
    }
  }
  return summary
}
