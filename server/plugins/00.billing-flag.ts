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
 * Override paths (in priority order):
 *   1. `NUXT_PUBLIC_DEPLOYMENT_PROFILE` / `_EDITION` / `_BILLING_MODE`
 *      — Nuxt env-overrides the public runtime config at boot, before
 *        any plugin runs. If set, this plugin doesn't need to touch
 *        the snapshot at all.
 *   2. `NUXT_PUBLIC_BILLING_ENABLED` — single-flag override for the
 *      legacy billingEnabled boolean only.
 *   3. This plugin's auto-derive — runs only when (1) is unset.
 *
 * Production caveat: Nitro's compiled output may freeze `useRuntimeConfig().public`
 * at boot, in which case mutation throws. The mutation is best-effort:
 * we log a single warning and let auto-detection silently fall through
 * — operators on production builds should set the public env vars
 * explicitly (see `.env.example` and `docs/DEPLOYMENT_PROFILES.md`).
 * In dev (`pnpm dev`), the runtime config is mutable, so auto-detect
 * works without operator intervention.
 */

import { __resetDeploymentCache, resolveDeployment } from '../utils/deployment'

let mutationFailedWarned = false

function tryAssign<T extends object>(target: T, key: keyof T, value: T[keyof T]): boolean {
  try {
    target[key] = value
    return true
  }
  catch {
    return false
  }
}

function applyDeploymentSnapshot(): void {
  const config = useRuntimeConfig()
  const publicConfig = config.public as Record<string, unknown>
  const deployment = resolveDeployment()

  // Skip if the operator already provided explicit public values via
  // NUXT_PUBLIC_DEPLOYMENT_* env (Nuxt has populated them at boot).
  const existing = publicConfig.deployment as { profile?: string, edition?: string, billingMode?: string } | undefined
  const explicitlySet = Boolean(existing && (existing.profile || existing.edition || existing.billingMode))

  if (!explicitlySet) {
    const ok = tryAssign(publicConfig, 'deployment', {
      profile: deployment.profile,
      edition: deployment.edition,
      billingMode: deployment.billingMode,
    })
    if (!ok && !mutationFailedWarned) {
      mutationFailedWarned = true
      // eslint-disable-next-line no-console
      console.warn('[deployment] runtimeConfig.public.deployment is read-only in this build; set NUXT_PUBLIC_DEPLOYMENT_PROFILE / _EDITION / _BILLING_MODE explicitly. See docs/DEPLOYMENT_PROFILES.md.')
    }
  }

  if (process.env.NUXT_PUBLIC_BILLING_ENABLED === undefined) {
    tryAssign(publicConfig, 'billingEnabled', deployment.billingMode !== 'off')
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
