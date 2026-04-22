/**
 * Auto-sync `runtimeConfig.public.billingEnabled` from the payment
 * plugin registry at boot.
 *
 * Rationale: the client UI reads `billingEnabled` from public runtime
 * config to decide whether to render checkout/portal flows. The server
 * already has the truth via `isBillingConfigured()` (which checks the
 * registered payment plugins' `isConfigured()` gate). Deriving the
 * public flag from that source removes the need for self-hosters to
 * also set `NUXT_PUBLIC_BILLING_ENABLED` — configuring the provider
 * env vars (e.g. `NUXT_POLAR_*`) is enough.
 *
 * Explicit override: if the deployment sets
 * `NUXT_PUBLIC_BILLING_ENABLED=true` (or `false`), that wins — useful
 * for staging where the provider is configured but billing UI should
 * stay hidden, or vice versa.
 *
 * Loaded before other plugins (`00.` prefix) so downstream plugins see
 * the resolved value.
 */

import { isBillingConfigured } from '../utils/license'

export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  const publicConfig = config.public as Record<string, unknown>

  // Explicit env override — respect it either way.
  if (process.env.NUXT_PUBLIC_BILLING_ENABLED !== undefined) return

  publicConfig.billingEnabled = isBillingConfigured()
})
