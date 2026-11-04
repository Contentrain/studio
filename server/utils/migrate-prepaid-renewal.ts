/**
 * "Keep Studio" at the end of a prepaid Studio year (migration 055/056).
 *
 * A prepaid year renews nothing by itself. From 30 days before it ends, the owner can open a subscription
 * to the plan of their choice: the yearly list product, with a trial that ends when the year does, so
 * nothing is charged before then. The subscription carries `migrate_renewal_grant_id` (not
 * `migrate_grant_id`): it uses no grant, brings no Migrate trial and is no duplicate of a bundle payment.
 * The billing webhook links it to the grant (`renewal_subscription_id`); the prepaid year keeps priority
 * until its end (`resolveBillingState`), and the subscription is the plan from then on.
 */
import { isPrepaidLive } from './billing'
import { startPlanCheckout } from './plan-checkout'

const DAY_MS = 24 * 60 * 60 * 1000
/** How long before the year's end "Keep Studio" opens; also the longest trial the renewal is given. */
export const PREPAID_RENEWAL_WINDOW_DAYS = 30

/** When "Keep Studio" opens for a year that ends at `endsAt`. */
export function prepaidRenewalOpensAt(endsAt: string | Date): Date {
  return new Date(new Date(endsAt).getTime() - PREPAID_RENEWAL_WINDOW_DAYS * DAY_MS)
}

/** The renewal's trial: the days left of the year, rounded up, at least 1 and at most the window. */
export function prepaidRenewalTrialDays(endsAt: string | Date, now: number = Date.now()): number {
  const left = Math.ceil((new Date(endsAt).getTime() - now) / DAY_MS)
  return Math.min(PREPAID_RENEWAL_WINDOW_DAYS, Math.max(1, left))
}

function refuse(statusCode: number, key: string, code: string): never {
  throw createError({ statusCode, message: errorMessage(key), data: { code } })
}

export async function startPrepaidRenewalCheckout(input: {
  workspace: { id: string, slug: string, name: string, prepaid_until?: unknown }
  plan: 'starter' | 'pro'
  customerEmail: string
  now?: number
}): Promise<{ url: string }> {
  const db = useDatabaseProvider()
  const now = input.now ?? Date.now()

  const grant = isPrepaidLive(input.workspace.prepaid_until, now) ? await db.getLivePrepaidGrant(input.workspace.id) : null
  // The grant must be the year the workspace holds: an older one, or one revoked since, renews nothing.
  if (!grant?.prepaid_ends_at || new Date(grant.prepaid_ends_at as string).getTime() !== new Date(input.workspace.prepaid_until as string).getTime())
    refuse(409, 'billing.prepaid_not_active', 'prepaid_not_active')
  const endsAt = grant.prepaid_ends_at as string
  if (now < prepaidRenewalOpensAt(endsAt).getTime()) refuse(409, 'billing.prepaid_renewal_not_open', 'renewal_not_open')
  if (grant.renewal_subscription_id) refuse(409, 'billing.prepaid_renewal_scheduled', 'renewal_scheduled')

  return startPlanCheckout({
    workspace: { id: input.workspace.id, slug: input.workspace.slug, name: input.workspace.name },
    plan: input.plan,
    customerEmail: input.customerEmail,
    withTrial: true,
    trialDays: prepaidRenewalTrialDays(endsAt, now),
    interval: 'year',
    metadata: { migrate_renewal_grant_id: String(grant.id) },
    continuesPrepaidYear: true,
    successPath: `/w/${input.workspace.slug}/settings?tab=billing&billing=success`,
    cancelPath: `/w/${input.workspace.slug}/settings?tab=billing&billing=cancelled`,
  })
}
