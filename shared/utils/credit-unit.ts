/**
 * Credit units — what one AI/API credit is worth, per payment account.
 *
 * Studio sold credits at $0.03 until catalog v2 (PRC-3), and sells them at
 * $0.01 from v2 on, with quotas, per-message ceilings, meters and overage
 * prices to match. The two cannot share a subscription: Polar grandfathers
 * a subscription's prices and grants its included credits in the meter it
 * was sold on, so a $0.03-era subscription metered in $0.01 credits would
 * be billed 3.2× for the same work (AI-9 D3).
 *
 * So the unit is a property of the account (`payment_accounts.credit_unit`,
 * written by the billing webhook from the meters the subscription is priced
 * on) and every credit figure is read through `creditTermsFor(unit)`:
 *
 * - `0.01` (current): the catalog's own numbers (`plan-features/data.json`)
 *   and the `_1c` meters. New checkouts and every account without a
 *   subscription (free, self-hosted, operator-set plans).
 * - `0.03` (legacy): the numbers the pre-v2 subscriptions were sold with,
 *   frozen below, and the original `ai_credits` / `api_credits` meters.
 *   Those subscriptions keep them (founder decision, 2026-09-23); nothing
 *   moves them to v2.
 *
 * Non-credit limits (media, CDN, forms, MCP calls) are the same for both
 * units — v2 only raised them — but their overage *prices* are what each
 * product was sold with, so they come from the terms too.
 */
import { OVERAGE_PRICING, getPlanLimitForPlan, normalizePlan, type HasFeatureOptions, type StudioPlan } from './license'

export type CreditUnit = '0.03' | '0.01'

/** The unit catalog v2 sells, and the default for accounts without a subscription. */
export const CURRENT_CREDIT_UNIT: CreditUnit = '0.01'
/** The unit pre-v2 subscriptions were sold in. */
export const LEGACY_CREDIT_UNIT: CreditUnit = '0.03'

/** Limit keys counted in credits — the only ones whose size depends on the unit. */
export const CREDIT_LIMIT_KEYS = ['ai.messages_per_month', 'api.messages_per_month'] as const
export type CreditLimitKey = typeof CREDIT_LIMIT_KEYS[number]

export function isCreditLimitKey(key: string): key is CreditLimitKey {
  return (CREDIT_LIMIT_KEYS as readonly string[]).includes(key)
}

/** Meter names per unit. The `0.03` ones are the meters legacy subscriptions are priced on. */
export const CREDIT_METERS: Record<CreditUnit, { ai: string, api: string }> = {
  0.03: { ai: 'ai_credits', api: 'api_credits' },
  0.01: { ai: 'ai_credits_1c', api: 'api_credits_1c' },
}

/**
 * The pre-v2 catalog, frozen. Only what differs from the current catalog is
 * here: credit quotas and ceilings, and every overage price (a subscription
 * is billed at the prices it was sold with).
 */
const LEGACY_TERMS = {
  quotas: {
    'ai.messages_per_month': { free: 0, starter: 60, pro: 350 },
    'api.messages_per_month': { free: 0, starter: 30, pro: 140 },
  } as Record<CreditLimitKey, Partial<Record<StudioPlan, number>>>,
  maxCreditsPerMessage: { starter: 30, default: 60 },
  overagePrices: {
    'ai.messages_per_month': 0.08,
    'api.messages_per_month': 0.08,
    'api.mcp_calls_per_month': 0.005,
    'forms.submissions_per_month': 0.01,
    'cdn.bandwidth_gb': 0.1,
    'media.storage_gb': 0.25,
  } as Record<string, number>,
}

/** Per-message credit ceilings in the current unit — the same dollars per turn as PRC-2 §3 ($0.75 / $1.50). */
const CURRENT_MAX_CREDITS_PER_MESSAGE = { starter: 75, default: 150 }

export interface CreditTerms {
  unit: CreditUnit
  /** Dollars of Anthropic spend one credit stands for. */
  unitUsd: number
  meters: { ai: string, api: string }
  /** A credit limit (`ai.messages_per_month`, `api.messages_per_month`) for a plan, in this unit. */
  creditLimit: (plan: StudioPlan | string | null | undefined, key: CreditLimitKey, options?: HasFeatureOptions) => number
  /** The credits one turn may take at most. */
  maxCreditsPerMessage: (plan: StudioPlan | string | null | undefined) => number
  /** Overage unit price for a limit, as the account's product sells it; undefined = not priced. */
  overagePrice: (limitKey: string) => number | undefined
  /**
   * Dollars → credits. The current unit rounds up (D2: a credit never costs
   * Studio more than it was sold for, at most 1¢ to the customer); the legacy
   * unit keeps the nearest rounding it was sold with.
   */
  toCredits: (usd: number) => number
}

const CURRENT_TERMS: CreditTerms = {
  unit: '0.01',
  unitUsd: 0.01,
  meters: CREDIT_METERS['0.01'],
  creditLimit: (plan, key, options) => getPlanLimitForPlan(plan, key, options),
  maxCreditsPerMessage: plan => normalizePlan(plan) === 'starter' ? CURRENT_MAX_CREDITS_PER_MESSAGE.starter : CURRENT_MAX_CREDITS_PER_MESSAGE.default,
  overagePrice: limitKey => OVERAGE_PRICING[limitKey]?.price,
  // Guard against float noise: 0.07 / 0.01 is 7.000000000000001.
  toCredits: usd => Math.ceil(Math.round((usd / 0.01) * 1e6) / 1e6),
}

const LEGACY: CreditTerms = {
  unit: '0.03',
  unitUsd: 0.03,
  meters: CREDIT_METERS['0.03'],
  creditLimit: (plan, key, options) => {
    const normalized = normalizePlan(plan)
    const frozen = LEGACY_TERMS.quotas[key][normalized]
    // Plans the legacy catalog never sold (community, enterprise) keep the
    // catalog's value — unlimited on both.
    return frozen ?? getPlanLimitForPlan(plan, key, options)
  },
  maxCreditsPerMessage: plan => normalizePlan(plan) === 'starter' ? LEGACY_TERMS.maxCreditsPerMessage.starter : LEGACY_TERMS.maxCreditsPerMessage.default,
  overagePrice: limitKey => LEGACY_TERMS.overagePrices[limitKey],
  toCredits: usd => Math.round(usd / 0.03),
}

export function creditTermsFor(unit: CreditUnit | string | null | undefined): CreditTerms {
  return unit === LEGACY_CREDIT_UNIT ? LEGACY : CURRENT_TERMS
}

/**
 * The unit a subscription is billed in, from the meters its prices use
 * (`payment_accounts.plugin_metadata.billable_meters`): a `_1c` credit meter
 * → current; a $0.03 credit meter (or the older event-counting ones) →
 * legacy. Null when the list names no credit meter at all — an event with no
 * metered prices says nothing about the unit, and the stored one must stay
 * (a pre-v2 account read as current would jump from 350 to 1 600 credits).
 */
export function creditUnitFromMeters(billableMeters: readonly string[] | null | undefined): CreditUnit | null {
  if (!billableMeters) return null
  const current = CREDIT_METERS['0.01']
  if (billableMeters.includes(current.ai) || billableMeters.includes(current.api)) return CURRENT_CREDIT_UNIT
  // `ai_messages` / `api_messages` are the event-counting meters older
  // subscriptions still price (ST-4) — the same $0.03 era.
  const legacyMeters = [CREDIT_METERS['0.03'].ai, CREDIT_METERS['0.03'].api, 'ai_messages', 'api_messages']
  return billableMeters.some(m => legacyMeters.includes(m)) ? LEGACY_CREDIT_UNIT : null
}

/** Both credit limits of a plan in a unit — for `getPlanParams` and the plan card. */
export function creditLimitsFor(plan: StudioPlan | string | null | undefined, unit: CreditUnit | string | null | undefined): Record<CreditLimitKey, number> {
  const terms = creditTermsFor(unit)
  return {
    'ai.messages_per_month': terms.creditLimit(plan, 'ai.messages_per_month'),
    'api.messages_per_month': terms.creditLimit(plan, 'api.messages_per_month'),
  }
}
