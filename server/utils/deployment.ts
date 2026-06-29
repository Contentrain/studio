/**
 * Deployment profile resolver.
 *
 * Studio supports four deployment shapes that differ along four
 * independent axes: edition (AGPL vs ee/), billing mode (off / polar /
 * stripe / flat), plan source (subscription / operator / fixed), and
 * tenancy (multi vs single). These are expressed as named profiles:
 *
 *   managed     — ee required, subscription-driven, multi-tenant
 *                 (contentrain.io SaaS)
 *   dedicated   — ee required, operator or subscription, single tenant
 *                 (Contentrain hosts one customer)
 *   on-premise  — ee required, operator-set plan, no managed billing
 *                 (customer runs `ee/` on their own infra)
 *   community   — agpl only, fixed `community` tier, no billing
 *                 (AGPL self-host without `ee/`)
 *
 * Resolution:
 *   1. If `NUXT_DEPLOYMENT_PROFILE` is set, honor it (operator override).
 *   2. Otherwise auto-detect from (a) ee/ bridge load success and
 *      (b) any configured payment plugin.
 *
 * The `dedicated` profile cannot be auto-detected (it is structurally
 * identical to `managed` at boot time). Set `NUXT_DEPLOYMENT_PROFILE`
 * explicitly when hosting a dedicated single-tenant deployment.
 *
 * Cached after first resolution for process lifetime; call sites can
 * treat the returned value as stable across requests.
 */

import { isBillingConfigured } from './license'
import { getLoadedEnterpriseBridge, isEnterpriseBridgeSettled } from './enterprise'
import type { Edition, StudioPlan } from '../../shared/utils/license'

export type DeploymentProfile = 'managed' | 'dedicated' | 'on-premise' | 'community'
export type BillingMode = 'off' | 'polar' | 'stripe' | 'flat'
export type PlanSource = 'subscription' | 'operator' | 'fixed'

export interface DeploymentState {
  profile: DeploymentProfile
  edition: Edition
  billingMode: BillingMode
  planSource: PlanSource
  /** When `planSource === 'fixed'`, the plan assigned to every workspace. */
  fixedPlan: StudioPlan | null
  /** When `planSource === 'operator'`, the fallback used if workspace.plan is null. */
  defaultPlan: StudioPlan
}

const VALID_PROFILES: readonly DeploymentProfile[] = ['managed', 'dedicated', 'on-premise', 'community']

let _cached: DeploymentState | null = null

function detectEdition(): Edition {
  return getLoadedEnterpriseBridge() !== null ? 'ee' : 'agpl'
}

function detectBillingMode(): BillingMode {
  if (!isBillingConfigured()) return 'off'
  const config = useRuntimeConfig() as unknown as { polar?: { accessToken?: string }, stripe?: { secretKey?: string } }
  if (config.polar?.accessToken) return 'polar'
  if (config.stripe?.secretKey) return 'stripe'
  return 'off'
}

function readExplicitProfile(): DeploymentProfile | null {
  const raw = process.env.NUXT_DEPLOYMENT_PROFILE?.trim()
  if (!raw) return null
  if ((VALID_PROFILES as readonly string[]).includes(raw)) return raw as DeploymentProfile
  // Invalid value — log and fall through to auto-detect.
  // eslint-disable-next-line no-console
  console.warn(`[deployment] NUXT_DEPLOYMENT_PROFILE="${raw}" is not one of ${VALID_PROFILES.join(', ')}; falling back to auto-detect.`)
  return null
}

function autoDetectProfile(edition: Edition, billingMode: BillingMode): DeploymentProfile {
  if (edition === 'agpl') return 'community'
  if (billingMode === 'polar' || billingMode === 'stripe') return 'managed'
  return 'on-premise'
}

function profileToState(profile: DeploymentProfile, edition: Edition, billingMode: BillingMode): DeploymentState {
  switch (profile) {
    case 'managed':
      return {
        profile,
        edition,
        billingMode,
        planSource: 'subscription',
        fixedPlan: null,
        defaultPlan: 'free',
      }
    case 'dedicated':
      return {
        profile,
        edition,
        billingMode,
        planSource: billingMode === 'off' || billingMode === 'flat' ? 'operator' : 'subscription',
        fixedPlan: null,
        defaultPlan: 'enterprise',
      }
    case 'on-premise':
      return {
        profile,
        edition,
        billingMode: 'off',
        planSource: 'operator',
        fixedPlan: null,
        defaultPlan: 'enterprise',
      }
    case 'community':
      return {
        profile,
        edition: 'agpl',
        billingMode: 'off',
        planSource: 'fixed',
        fixedPlan: 'community',
        defaultPlan: 'community',
      }
  }
}

/**
 * Resolve the deployment state for this process.
 *
 * First call computes and caches. Subsequent calls return the cached
 * state. Tests can reset via `__resetDeploymentCache()`.
 */
export function resolveDeployment(): DeploymentState {
  if (_cached) return _cached

  const edition = detectEdition()
  const billingMode = detectBillingMode()
  const explicit = readExplicitProfile()
  const profile = explicit ?? autoDetectProfile(edition, billingMode)
  const settled = isEnterpriseBridgeSettled()

  // Explicit non-community profile while ee/ is not (yet) loaded.
  //
  // Before the bridge promise settles, `edition === 'agpl'` is a
  // transient reading (the dynamic `import('ee/enterprise')` may still
  // be in flight). Return a community shape as the failsafe, but do NOT
  // latch `_cached` — otherwise a pre-boot caller would freeze the state
  // to community for the process lifetime even though ee/ is about to
  // load successfully.
  //
  // Once settled with the bridge still absent (ee/ genuinely failed to
  // load — e.g. a native dependency like sharp failing to initialize on
  // a particular deploy), HONOR the operator's explicit profile for
  // plan/billing resolution instead of silently downgrading every
  // workspace to the fixed `community` tier. A transient ee-load failure
  // must not wipe paid plans until the next redeploy. Edition stays
  // `agpl`, so `requires_ee` features degrade off via `hasFeature`; only
  // the ee feature surface is lost, not billing/plan correctness.
  if (explicit && explicit !== 'community' && edition === 'agpl') {
    if (!settled) {
      return profileToState('community', edition, billingMode)
    }
    // eslint-disable-next-line no-console
    console.warn(`[deployment] NUXT_DEPLOYMENT_PROFILE="${explicit}" is set but the enterprise bridge did not load; serving in degraded mode — plan/billing honored, ee/ features disabled.`)
    _cached = profileToState(explicit, edition, billingMode)
    return _cached
  }

  const state = profileToState(profile, edition, billingMode)
  if (settled) _cached = state
  return state
}

/** Test helper — clear the cached state. */
export function __resetDeploymentCache(): void {
  _cached = null
}
