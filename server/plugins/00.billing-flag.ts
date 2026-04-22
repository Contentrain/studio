/**
 * Deployment snapshot sync — exposes the resolved deployment profile
 * to the client via `runtimeConfig.public.deployment` and derives the
 * legacy `runtimeConfig.public.billingEnabled` boolean.
 *
 * Runs before other plugins (`00.` prefix) and before
 * `01.init-ee.ts`. The enterprise bridge is loaded after this plugin,
 * so the first call to `resolveDeployment()` sees `edition='agpl'`
 * even in Enterprise-configured deployments. That is why the plugin
 * also resets the deployment cache and re-resolves at the end of boot
 * via a microtask — by then `01.init-ee.ts` has awaited the dynamic
 * import and the bridge is registered.
 *
 * Explicit override: if the operator sets `NUXT_PUBLIC_BILLING_ENABLED`
 * explicitly (either `true` or `false`), that value wins for the
 * billingEnabled flag — useful for staging where the provider is
 * configured but checkout should stay hidden, or vice versa.
 */

import { __resetDeploymentCache, resolveDeployment } from '../utils/deployment'

function applyDeploymentSnapshot(): void {
  const config = useRuntimeConfig()
  const publicConfig = config.public as Record<string, unknown>
  const deployment = resolveDeployment()

  publicConfig.deployment = {
    profile: deployment.profile,
    edition: deployment.edition,
    billingMode: deployment.billingMode,
  }

  if (process.env.NUXT_PUBLIC_BILLING_ENABLED === undefined) {
    publicConfig.billingEnabled = deployment.billingMode !== 'off'
  }
}

export default defineNitroPlugin(() => {
  // First pass — runs before the ee bridge loads, so edition may read
  // as 'agpl' even when `ee/` is about to be imported.
  applyDeploymentSnapshot()

  // Second pass — after the ee init plugin has had a chance to load
  // the bridge. We re-resolve with a cleared cache so the edition is
  // accurate for the rest of the process lifetime.
  queueMicrotask(() => {
    __resetDeploymentCache()
    applyDeploymentSnapshot()
  })
})
