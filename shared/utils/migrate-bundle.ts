/**
 * What the Studio line of a "Migrate with Studio" bundle costs.
 *
 * The bundle's first invoice carries Studio year 1 at 20% off the yearly list
 * price; the subscription then renews at the list price (the webhook moves it
 * to the yearly product, effective at the next period). Cents, USD.
 */
import type { MigrateStudioPlan } from '@contentrain/types'

/** Yearly list price per plan — the renewal amount ("Studio Starter/Pro Yearly"). */
export const STUDIO_YEARLY_LIST_CENTS: Record<MigrateStudioPlan, number> = { starter: 9000, pro: 49000 }

/** Share of the list price year 1 pays when it rides on a Migrate order. */
export const MIGRATE_BUNDLE_DISCOUNT = 0.2

const PLAN_RANK: Record<MigrateStudioPlan, number> = { starter: 0, pro: 1 }

/** Year 1 of `plan`, 20% off the yearly list price. */
export function bundleYear1Cents(plan: MigrateStudioPlan): number {
  return Math.round(STUDIO_YEARLY_LIST_CENTS[plan] * (1 - MIGRATE_BUNDLE_DISCOUNT))
}

/** What moving from `current` up to `plan` adds: the difference of their year-1 prices. */
export function bundleUpgradeCents(plan: MigrateStudioPlan, current: MigrateStudioPlan): number {
  return Math.max(0, bundleYear1Cents(plan) - bundleYear1Cents(current))
}

export function planCovers(current: MigrateStudioPlan, needed: MigrateStudioPlan): boolean {
  return PLAN_RANK[current] >= PLAN_RANK[needed]
}
