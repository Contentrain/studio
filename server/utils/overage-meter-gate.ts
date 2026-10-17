/**
 * What a daily meter may bill for CDN origin transfer and media storage.
 *
 * Both meters report a workspace's whole usage, and the payment provider bills
 * whatever lies past the plan's included units. That is only right while the
 * customer has overage on: without it the limit is hard, and the CDN's grace
 * (delivery continues up to 120 % of the plan, `cdn-limit.ts`) is Studio's to
 * pay — the app, the docs and the pricing page all say so. So a day is billed in
 * full only when overage was on, and sellable, for the whole of it; any other day
 * reports only what still fits under the plan line, which the included units
 * absorb. Nothing past the plan is ever billed for a day the toggle did not cover.
 *
 * "Covered" needs to know when the toggle was turned on: the meter reports a day
 * after it has ended (and the CDN meter looks back two days), so the state at run
 * time alone would bill a day that ran without overage. The instant is kept on the
 * active payment account (`plugin_metadata`, one key per toggle): the toggle route
 * writes and clears it, and the meter sets it the first time it sees a toggle that
 * is on without one (a toggle from before this rule, one the billing webhook
 * re-enabled). A missing or lost instant only ever bills less.
 */

import { USAGE_METER_LIST } from '../../shared/utils/usage-meters'
import { getPlanLimit } from './license'
import { useDatabaseProvider } from './providers'
import { billableOverageSettings } from './workspace-billing'

/** The `plugin_metadata` key holding when a toggle was turned on (ISO instant). */
export function overageOnSinceKey(settingsKey: string): string {
  return `overage_on_since_${settingsKey}`
}

/**
 * Every such key: the toggles whose meter costs Studio per unit. Written only through
 * `setPaymentAccountMetadataKey` / `…Json`, so the billing webhook's read-then-write keeps them.
 */
export const OVERAGE_ON_SINCE_KEYS: string[] = USAGE_METER_LIST.filter(m => m.requiresKnownPrice).map(m => overageOnSinceKey(m.settingsKey))

type GateDb = Pick<ReturnType<typeof useDatabaseProvider>, 'getWorkspaceById' | 'getActivePaymentAccount' | 'setPaymentAccountMetadataKey' | 'setPaymentAccountMetadataJson'>

export interface OverageDayGate {
  /** The workspace's plan column (what the delivery path and the product's included units use). */
  plan: string | null
  /** Overage was on and sellable from `dayStart` on: the day may be billed past the plan. */
  covered: boolean
}

function readSince(pluginMetadata: unknown, key: string): Date | null {
  if (!pluginMetadata || typeof pluginMetadata !== 'object') return null
  const raw = (pluginMetadata as Record<string, unknown>)[key]
  if (typeof raw !== 'string') return null
  const since = new Date(raw)
  return Number.isNaN(since.getTime()) ? null : since
}

/**
 * Whether `settingsKey`'s overage covers the day starting at `dayStart`, and
 * the plan to cap against when it does not. Keeps the stored "on since" instant
 * in step with the toggle as a side effect.
 */
export async function overageDayGate(input: {
  workspaceId: string
  settingsKey: string
  dayStart: Date
  now: Date
  db?: GateDb
}): Promise<OverageDayGate> {
  const db = input.db ?? useDatabaseProvider()
  const workspace = await db.getWorkspaceById(input.workspaceId, 'plan, overage_settings')
  const plan = typeof workspace?.plan === 'string' ? workspace.plan : null
  const settings = await billableOverageSettings(db, input.workspaceId, workspace?.overage_settings)
  const on = settings[input.settingsKey] === true
  const key = overageOnSinceKey(input.settingsKey)
  const account = await db.getActivePaymentAccount(input.workspaceId)
  const since = readSince(account?.plugin_metadata, key)

  if (!on) {
    if (since) await db.setPaymentAccountMetadataJson({ workspaceId: input.workspaceId, key, value: null })
    return { plan, covered: false }
  }
  if (!since) {
    // On, but nobody recorded when: count it from now, so no day already run is billed past the plan.
    if (account) await db.setPaymentAccountMetadataKey({ workspaceId: input.workspaceId, key, value: input.now.toISOString(), when: 'absent' })
    return { plan, covered: false }
  }
  return { plan, covered: since.getTime() <= input.dayStart.getTime() }
}

/** The plan's limit for `limitKey` in bytes (GB-valued limits), or Infinity when it has none. */
export function planLimitBytes(plan: string | null, limitKey: 'cdn.bandwidth_gb' | 'media.storage_gb'): number {
  const gb = getPlanLimit(plan, limitKey)
  return Number.isFinite(gb) ? gb * 1024 ** 3 : Infinity
}

/**
 * The part of a day's bytes that lies under the plan line: `before` bytes were
 * used earlier in the period, `day` today. With nothing over the line it is
 * `day` as is; past it, zero.
 */
export function bytesUnderLimit(before: number, day: number, limit: number): number {
  if (!Number.isFinite(limit)) return day
  return Math.max(0, Math.min(before + day, limit) - Math.min(before, limit))
}
