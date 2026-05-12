/**
 * Deployment snapshot sync — exposes the resolved deployment profile
 * to the client via `runtimeConfig.public.deployment` and derives the
 * legacy `runtimeConfig.public.billingEnabled` boolean.
 *
 * Boot ordering:
 *   1. `await initEnterpriseBridge()` — wait for the dynamic
 *      `import('ee/enterprise')` to settle (resolved bridge or proven
 *       absent for Community Edition).
 *   2. `applyDeploymentSnapshot()` — write `runtimeConfig.public.deployment`
 *      once, after `resolveDeployment()` can see a settled edition.
 *
 * Why this matters: `resolveDeployment()` reads the bridge state
 * synchronously via `getLoadedEnterpriseBridge()`. Calling it before
 * the import has settled would return a transient `edition: 'agpl'`
 * reading — and prior to the settle-aware cache rule in
 * `server/utils/deployment.ts`, it used to latch that reading into
 * `_cached` for the process lifetime, breaking every EE feature gate.
 *
 * `01.init-ee.ts` also awaits the bridge; this plugin awaiting it again
 * is a cheap no-op (the promise is memoized in the enterprise globals)
 * and removes the dependency on plugin filename ordering for the
 * snapshot's correctness.
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

import { initEnterpriseBridge } from '../utils/enterprise'
import { resolveDeployment } from '../utils/deployment'

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

export default defineNitroPlugin(async () => {
  // Wait for the EE bridge import to settle before resolving the
  // deployment state. This guarantees `resolveDeployment()` sees the
  // correct `edition` on first call instead of the transient `agpl`
  // reading the dynamic import would yield mid-flight.
  await initEnterpriseBridge()
  applyDeploymentSnapshot()
})
