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
import { COMPANION_CLAIM_KEY, COMPANION_METERS_KEY, COMPANION_SUBSCRIPTION_KEY, isYearlyPeriod } from './overage-lock'

type Db = Pick<DatabaseProvider, 'setPaymentAccountMetadataKey' | 'getActivePaymentAccount'>

/** A claim still `opening` after this long belongs to a worker that died; another may take it over. */
const OPENING_STALE_MS = 10 * 60 * 1000

/** The companion's subscription id stored on an account, or null. */
export function companionSubscriptionIdOf(pluginMetadata: unknown): string | null {
  if (!pluginMetadata || typeof pluginMetadata !== 'object') return null
  const id = (pluginMetadata as Record<string, unknown>)[COMPANION_SUBSCRIPTION_KEY]
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function companionClaimOf(pluginMetadata: unknown): string | null {
  if (!pluginMetadata || typeof pluginMetadata !== 'object') return null
  const claim = (pluginMetadata as Record<string, unknown>)[COMPANION_CLAIM_KEY]
  return typeof claim === 'string' ? claim : null
}

/** Whether a stored claim leaves nothing for the reconciler to do. */
export function claimSettled(pluginMetadata: unknown): boolean {
  const claim = companionClaimOf(pluginMetadata)
  return Boolean(claim && (claim.startsWith('done:') || claim.startsWith('skipped:')))
}

export type CompanionOpenOutcome = 'opened' | 'existing' | 'skipped' | 'busy' | 'failed'

/**
 * Take the right to open this workspace's companion. The claim is one conditional write on the account row, so of
 * several concurrent callers (the plan's created and updated webhooks, the reconciler) exactly one proceeds.
 * Returns the claim it replaced (null when there was none), or false when somebody else holds it.
 */
async function claimOpening(db: Db, workspaceId: string, productId: string | null | undefined): Promise<{ previous: string | null, value: string } | false> {
  const value = `opening:${Date.now()}`
  if (await db.setPaymentAccountMetadataKey({ workspaceId, key: COMPANION_CLAIM_KEY, value, when: 'absent' })) return { previous: null, value }
  const account = await db.getActivePaymentAccount(workspaceId)
  if (!account) return false
  const current = companionClaimOf(account.plugin_metadata)
  if (current === null) return false
  const startedAt = current.startsWith('opening:') ? Number(current.slice('opening:'.length)) : Number.NaN
  const stale = Number.isFinite(startedAt) && Date.now() - startedAt > OPENING_STALE_MS
  const settledFor = current.startsWith('done:') ? current.slice('done:'.length) : current.startsWith('skipped:') ? current.slice('skipped:'.length) : null
  // A claim the reconciler stamped does not know its product (`done:`): that is not a change. Learn it, once.
  if (settledFor === '' && productId) {
    await db.setPaymentAccountMetadataKey({ workspaceId, key: COMPANION_CLAIM_KEY, value: `${current.slice(0, current.indexOf(':'))}:${productId}`, when: { equals: current } })
    return false
  }
  const productChanged = settledFor !== null && settledFor !== '' && Boolean(productId) && settledFor !== productId
  if (current !== 'failed' && current !== '' && !stale && !productChanged) return false
  return (await db.setPaymentAccountMetadataKey({ workspaceId, key: COMPANION_CLAIM_KEY, value, when: { equals: current } })) ? { previous: current, value } : false
}

/**
 * Open (or find) the companion for a plan subscription and record it on the account. Serialized per workspace by
 * `claimOpening`; if the plan moved to another product, the old companion is cancelled first (a failure there
 * throws, so the webhook is retried). Every other failure is logged as an ALARM and left for the reconciler.
 */
export async function openCompanionSubscription(
  provider: PaymentProvider,
  db: Db,
  input: { workspaceId: string, plan: string | null | undefined, customerId: string, subscriptionId: string | null | undefined, productId: string | null | undefined },
): Promise<CompanionOpenOutcome> {
  if (!provider.ensureCompanionSubscription || provider.companionUsageEnabled?.() === false) return 'skipped'
  if ((input.plan !== 'starter' && input.plan !== 'pro') || !input.subscriptionId) return 'skipped'
  const { workspaceId } = input
  const claim = await claimOpening(db, workspaceId, input.productId)
  if (!claim) return 'busy'
  const setClaim = (value: string, from: string) => db.setPaymentAccountMetadataKey({ workspaceId, key: COMPANION_CLAIM_KEY, value, when: { equals: from } })
  const held = claim.value
  try {
    // The plan moved to another product: the companion of the old one carries the wrong prices and credits.
    if (claim.previous?.startsWith('done:')) {
      const account = await db.getActivePaymentAccount(workspaceId)
      await cancelCompanionSubscription(provider, account?.plugin_metadata, `plan product changed from ${claim.previous.slice('done:'.length)}`, true)
      await db.setPaymentAccountMetadataKey({ workspaceId, key: COMPANION_METERS_KEY, value: '', when: 'different' })
      await db.setPaymentAccountMetadataKey({ workspaceId, key: COMPANION_SUBSCRIPTION_KEY, value: '', when: 'different' })
    }
  }
  catch (err) {
    // Hand the claim back as it was, so the retry takes the same path.
    await setClaim(claim.previous ?? 'failed', held).catch(() => {})
    throw err
  }
  try {
    const companion = await provider.ensureCompanionSubscription({
      workspaceId,
      plan: input.plan,
      customerId: input.customerId,
      parentSubscriptionId: input.subscriptionId,
      ...(input.productId ? { parentProductId: input.productId } : {}),
    })
    if (!companion) {
      await setClaim(`skipped:${input.productId ?? ''}`, held)
      return 'skipped'
    }
    await db.setPaymentAccountMetadataKey({ workspaceId, key: COMPANION_SUBSCRIPTION_KEY, value: companion.subscriptionId, when: 'different' })
    await setClaim(`done:${input.productId ?? ''}`, held)
    return companion.created ? 'opened' : 'existing'
  }
  catch (err) {
    // eslint-disable-next-line no-console -- the alarm: watched by the platform's log alert; the reconciler retries
    console.error(`[companion] ALARM could not open the usage subscription for workspace ${workspaceId} (plan subscription ${input.subscriptionId}):`, err)
    await setClaim('failed', held).catch(() => {})
    return 'failed'
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
    && !companionSubscriptionIdOf(row.plugin_metadata)
    && !claimSettled(row.plugin_metadata),
  )
}

const RECONCILE_PAGE = 500

/**
 * Open the companion for every active yearly plan that lacks one (a webhook that failed to open it, or a
 * subscription that predates the flag). The provider decides whether the account's product gets one at all.
 * Goes through the same per-workspace claim as the webhook, so the two cannot open it twice.
 */
export async function reconcileCompanionSubscriptions(
  provider: PaymentProvider,
  db: Db & Pick<DatabaseProvider, 'listActivePaymentAccounts'>,
  providerKey: string,
): Promise<CompanionReconcileSummary> {
  const summary: CompanionReconcileSummary = { checked: 0, opened: 0, failed: 0 }
  // Off: no companion step runs and the accounts are not even listed.
  if (!provider.ensureCompanionSubscription || provider.companionUsageEnabled?.() !== true) return summary
  const rows = await db.listActivePaymentAccounts(providerKey, RECONCILE_PAGE)
  if (rows.length >= RECONCILE_PAGE) {
    // eslint-disable-next-line no-console -- accounts past the page are not looked at; this needs paging before then
    console.warn(`[companion] reconcile saw ${rows.length} active accounts, the page limit: later ones are not checked`)
  }
  for (const row of accountsMissingCompanion(rows)) {
    summary.checked++
    const workspaceId = String(row.workspace_id)
    try {
      // The account does not store the plan subscription's product: the provider reads it from the subscription.
      const outcome = await openCompanionSubscription(provider, db, {
        workspaceId,
        plan: row.plan === 'pro' ? 'pro' : 'starter',
        customerId: String(row.customer_id),
        subscriptionId: String(row.subscription_id),
        productId: null,
      })
      if (outcome === 'opened') summary.opened++
      if (outcome === 'failed') summary.failed++
    }
    catch (err) {
      summary.failed++
      // eslint-disable-next-line no-console -- the alarm: watched by the platform's log alert
      console.error(`[companion] ALARM reconcile could not open the usage subscription for workspace ${workspaceId}:`, err)
    }
  }
  return summary
}
