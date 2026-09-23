/**
 * Overage the subscription cannot bill — and therefore must not sell.
 *
 * `overage_settings` is the customer's preference; this module decides
 * whether the payment side can honour it. Two cases cannot:
 *
 * - **Trialing.** Nothing past the plan allowance is sold during a trial:
 *   the customer has not paid for the plan yet, and usage above it would be
 *   billed (or not) depending on how the provider treats a trial's metered
 *   balance. The lock lifts when the trial ends.
 * - **The subscription does not price the meter.** A provider subscription
 *   keeps the prices it was created with — Polar does not move existing
 *   subscriptions when a product's prices change. A subscription created
 *   before the `ai_credits` / `api_credits` meters has no price for them,
 *   so usage past the limit would be consumed and never invoiced.
 *
 * The meters a subscription prices are recorded by the billing webhook in
 * `payment_accounts.plugin_metadata.billable_meters` (the webhook carries
 * the subscription's price list, and fires again whenever it changes). No
 * list recorded means the provider never reported one: only the trial rule
 * applies then, which keeps providers that do not report prices working as
 * before.
 *
 * A lock only ever stops the sale of usage *past* the plan limit; what the
 * plan includes is never touched. It is also temporary by construction: a
 * toggle it turns off is remembered in `plugin_metadata.overage_suspended`
 * and turned back on by the webhook that lifts the lock (trial ends, the
 * subscription is moved to current prices) — nobody has to re-enable it.
 */

import { OVERAGE_SETTINGS_KEYS } from '../../shared/utils/license'
import { USAGE_METERS, USAGE_METER_LIST } from '../../shared/utils/usage-meters'
import { CURRENT_CREDIT_UNIT, creditTermsFor, creditUnitFromMeters } from '../../shared/utils/credit-unit'

export type OverageLockReason = 'trialing' | 'not_in_subscription'

export interface OverageLock {
  reason: OverageLockReason
  /** When the lock lifts on its own (trial end), or null when it does not. */
  until: string | null
}

/** The payment account fields this module reads. */
export interface OverageLockAccount {
  subscription_status?: string | null
  trial_ends_at?: string | Date | null
  current_period_end?: string | Date | null
  plugin_metadata?: unknown
}

/** Keys inside `payment_accounts.plugin_metadata`. */
export const BILLABLE_METERS_KEY = 'billable_meters'
export const OVERAGE_SUSPENDED_KEY = 'overage_suspended'

const METER_NAME_BY_SETTINGS_KEY: Record<string, string> = Object.fromEntries(
  USAGE_METER_LIST.map(m => [m.settingsKey, m.name]),
)

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** The meters the subscription prices, or null when none were recorded. */
export function readBillableMeters(pluginMetadata: unknown): string[] | null {
  if (!pluginMetadata || typeof pluginMetadata !== 'object') return null
  const list = (pluginMetadata as Record<string, unknown>)[BILLABLE_METERS_KEY]
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : null
}

/** Locked overage settings keys, each with why and until when. */
export function resolveOverageLocks(account: OverageLockAccount | null | undefined): Record<string, OverageLock> {
  const locks: Record<string, OverageLock> = {}
  if (!account) return locks

  if (account.subscription_status === 'trialing') {
    const until = toIso(account.trial_ends_at) ?? toIso(account.current_period_end)
    for (const key of OVERAGE_SETTINGS_KEYS) locks[key] = { reason: 'trialing', until }
    return locks
  }

  const billable = readBillableMeters(account.plugin_metadata)
  if (!billable) return locks
  // Credit overage is priced on the meters of the subscription's own unit:
  // a pre-v2 subscription prices `ai_credits`, a v2 one `ai_credits_1c`.
  const creditMeters = creditTermsFor(creditUnitFromMeters(billable) ?? CURRENT_CREDIT_UNIT).meters
  for (const key of OVERAGE_SETTINGS_KEYS) {
    const meter = key === USAGE_METERS.AI_MESSAGES.settingsKey
      ? creditMeters.ai
      : key === USAGE_METERS.API_MESSAGES.settingsKey ? creditMeters.api : METER_NAME_BY_SETTINGS_KEY[key]
    if (!meter || !billable.includes(meter)) locks[key] = { reason: 'not_in_subscription', until: null }
  }
  return locks
}

/** `settings` with every locked key forced off — what enforcement must use. */
export function withoutLockedOverage(
  settings: Record<string, boolean> | null | undefined,
  locks: Record<string, OverageLock>,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...(settings ?? {}) }
  for (const key of Object.keys(locks)) {
    if (out[key] === true) out[key] = false
  }
  return out
}

export interface OverageLockReconcileInput {
  /** The workspace's stored `overage_settings`. */
  settings: Record<string, boolean> | null | undefined
  /** The payment account's stored `plugin_metadata`. */
  pluginMetadata: unknown
  /** Priced meters the provider just reported; undefined = unchanged. */
  billableMeters?: string[]
  /** The subscription state being written. */
  account: Omit<OverageLockAccount, 'plugin_metadata'>
}

export interface OverageLockReconcileResult {
  /** New `overage_settings`, or null when nothing changes. */
  settings: Record<string, boolean> | null
  /** New `plugin_metadata`, or undefined when nothing changes. */
  pluginMetadata: Record<string, unknown> | undefined
}

/**
 * Bring a workspace's toggles in line with what its subscription can bill.
 *
 * A toggle that is on and now locked is turned off and remembered as
 * suspended. A suspended toggle whose lock has lifted is turned back on.
 * Everything else is left as the customer set it.
 */
export function reconcileOverageLock(input: OverageLockReconcileInput): OverageLockReconcileResult {
  const stored = input.pluginMetadata && typeof input.pluginMetadata === 'object'
    ? input.pluginMetadata as Record<string, unknown>
    : {}
  const { [OVERAGE_SUSPENDED_KEY]: _storedSuspended, ...meta } = stored
  if (input.billableMeters) meta[BILLABLE_METERS_KEY] = input.billableMeters

  const locks = resolveOverageLocks({ ...input.account, plugin_metadata: meta })
  const current = input.settings ?? {}
  const next: Record<string, boolean> = { ...current }
  const suspended = new Set(
    Array.isArray(stored[OVERAGE_SUSPENDED_KEY])
      ? (stored[OVERAGE_SUSPENDED_KEY] as unknown[]).filter((k): k is string => typeof k === 'string')
      : [],
  )

  for (const key of Object.keys(locks)) {
    if (next[key] === true) {
      next[key] = false
      suspended.add(key)
    }
  }
  for (const key of [...suspended]) {
    if (locks[key]) continue
    next[key] = true
    suspended.delete(key)
  }

  if (suspended.size > 0) meta[OVERAGE_SUSPENDED_KEY] = [...suspended].toSorted()

  const settingsChanged = Object.keys(next).some(key => next[key] !== current[key])
  const metaChanged = JSON.stringify(meta) !== JSON.stringify(stored)
  return {
    settings: settingsChanged ? next : null,
    pluginMetadata: metaChanged ? meta : undefined,
  }
}
