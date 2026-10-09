/**
 * What the Studio line of a "Migrate with Studio" bundle costs.
 *
 * Founder rule (2026-10-08): Studio is never discounted beyond the yearly plan.
 * The bundle's first invoice carries Studio year 1 at the yearly list price —
 * the same amount the subscription renews at (the webhook moves it to the
 * yearly product, effective at the next period). The bundle's own saving sits
 * on the Migrate side (Migrate's credit on its fee), never on Studio. What a
 * yearly plan saves against paying month by month is the only comparison
 * Studio makes, and it comes from the plan config, not from a literal. Cents, USD.
 */
import type { MigrateStudioPlan } from '@contentrain/types'
import { PLAN_PRICING } from './license'

/** Yearly list price per plan — the first-year amount and the renewal amount ("Studio Starter/Pro Yearly"). */
export const STUDIO_YEARLY_LIST_CENTS: Record<MigrateStudioPlan, number> = { starter: 9000, pro: 49000 }

const PLAN_RANK: Record<MigrateStudioPlan, number> = { starter: 0, pro: 1 }

/** Year 1 of `plan` on a Migrate order: the yearly list price, nothing taken off. */
export function bundleYear1Cents(plan: MigrateStudioPlan): number {
  return STUDIO_YEARLY_LIST_CENTS[plan]
}

/** What moving from `current` up to `plan` adds: the difference of their yearly list prices. */
export function bundleUpgradeCents(plan: MigrateStudioPlan, current: MigrateStudioPlan): number {
  return Math.max(0, bundleYear1Cents(plan) - bundleYear1Cents(current))
}

/** A year of `plan` paid month by month: its monthly list price (plan config) × 12. */
export function monthlyListCents(plan: MigrateStudioPlan): number {
  return PLAN_PRICING[plan].priceMonthly * 12 * 100
}

/**
 * How the yearly price explains itself against monthly × 12: the saving in cents and the same saving in whole
 * months of the monthly price ("2 months free compared to monthly"). Both derived; a plan whose yearly price is
 * not under monthly × 12 saves nothing and the months read 0.
 */
export function yearlySaving(plan: MigrateStudioPlan): { savingCents: number, monthsFree: number } {
  const monthly = PLAN_PRICING[plan].priceMonthly * 100
  const savingCents = Math.max(0, monthlyListCents(plan) - STUDIO_YEARLY_LIST_CENTS[plan])
  return { savingCents, monthsFree: monthly > 0 ? Math.floor(savingCents / monthly) : 0 }
}

export function planCovers(current: MigrateStudioPlan, needed: MigrateStudioPlan): boolean {
  return PLAN_RANK[current] >= PLAN_RANK[needed]
}
