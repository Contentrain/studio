/**
 * Payment provider plugin system — public API.
 *
 * Import from this module rather than the internal files:
 *
 *   import { bootstrapPaymentPlugins, resolveDefaultPlugin } from '~/server/providers/payment'
 *   import type { PaymentProvider } from '~/server/providers/payment'
 *
 * Built-in plugins:
 *   - `stripe` — active when `NUXT_STRIPE_SECRET_KEY` is set
 *   - `polar`  — active when `NUXT_POLAR_ACCESS_TOKEN` is set (registered later)
 *
 * To add a new provider: implement `PaymentProviderPlugin` under
 * `./plugins/<key>.ts`, then add a `registerPlugin(...)` line inside
 * `bootstrapPaymentPlugins()` below.
 */

import { registerPlugin } from './registry'
import { stripePlugin } from './plugins/stripe'

let bootstrapped = false

/**
 * Register all built-in payment plugins.
 *
 * Idempotent — safe to call from multiple entry points. The factory in
 * `server/utils/providers.ts` calls this lazily on first provider lookup.
 */
export function bootstrapPaymentPlugins(): void {
  if (bootstrapped) return
  registerPlugin(stripePlugin)
  bootstrapped = true
}

/** Test helper — reset bootstrap state (does not clear registry). */
export function __resetBootstrapForTests(): void {
  bootstrapped = false
}

export * from './types'
export { listPlugins, registerPlugin, resolveDefaultPlugin, resolvePlugin, unregisterPlugin } from './registry'
