/**
 * Payment provider plugin registry.
 *
 * A small in-memory map from plugin key → plugin definition. Plugins are
 * registered once at boot by `bootstrapPaymentPlugins()` in `./index.ts`.
 * The factory (`usePaymentProvider`) resolves the default plugin from
 * this registry using a preference-ordered walk.
 */

import type { PaymentPluginConfig, PaymentProviderPlugin } from './types'

const plugins = new Map<string, PaymentProviderPlugin>()

/**
 * Preference order for the default plugin when multiple are configured.
 * Polar is preferred over Stripe because new deployments default to Polar;
 * existing Stripe installations stay opt-in via their own `isConfigured()` gate.
 */
const DEFAULT_PREFERENCE: readonly string[] = ['polar', 'stripe']

export function registerPlugin(plugin: PaymentProviderPlugin): void {
  plugins.set(plugin.key, plugin)
}

export function unregisterPlugin(key: string): void {
  plugins.delete(key)
}

export function resolvePlugin(key: string): PaymentProviderPlugin | null {
  return plugins.get(key) ?? null
}

export function listPlugins(): PaymentProviderPlugin[] {
  return [...plugins.values()]
}

/**
 * Resolve the default plugin for a runtime config.
 *
 * Walks `preferredKeys` in order and returns the first registered plugin
 * whose `isConfigured()` returns true. Returns null when no plugin is
 * configured (self-hosted / no-billing mode).
 */
export function resolveDefaultPlugin(
  config: PaymentPluginConfig,
  preferredKeys: readonly string[] = DEFAULT_PREFERENCE,
): PaymentProviderPlugin | null {
  for (const key of preferredKeys) {
    const plugin = plugins.get(key)
    if (plugin?.isConfigured(config)) return plugin
  }
  return null
}

/** Test helper — clear all registrations. Not exported from `./index.ts`. */
export function __resetRegistryForTests(): void {
  plugins.clear()
}
