/**
 * Client-side deployment snapshot.
 *
 * Reads `runtimeConfig.public.deployment` (populated at boot by the
 * `server/plugins/00.billing-flag.ts` Nitro plugin) and exposes it as
 * a typed, reactive composable with convenience flags. This is the
 * single source of truth every UI surface should consult when its
 * rendering depends on edition or profile.
 *
 * Server-side deployment state (`planSource`, `fixedPlan`, etc.) is
 * intentionally not exposed here — the client only needs the three
 * user-visible axes.
 */

export type DeploymentProfile = 'managed' | 'dedicated' | 'on-premise' | 'community' | ''
export type DeploymentEdition = 'ee' | 'agpl' | ''
export type DeploymentBillingMode = 'polar' | 'stripe' | 'flat' | 'off' | ''

interface DeploymentSnapshot {
  profile: DeploymentProfile
  edition: DeploymentEdition
  billingMode: DeploymentBillingMode
}

export function useDeployment() {
  const config = useRuntimeConfig()
  const raw = (config.public as { deployment?: Partial<DeploymentSnapshot> }).deployment ?? {}

  const profile = (raw.profile ?? '') as DeploymentProfile
  const edition = (raw.edition ?? '') as DeploymentEdition
  const billingMode = (raw.billingMode ?? '') as DeploymentBillingMode

  // Fail safe: unknown edition (empty string) is treated as community.
  // This happens briefly on client boot if the server plugin hasn't
  // populated public.deployment yet, or if a test harness doesn't stub
  // it. The conservative choice is to hide enterprise UI until the
  // snapshot is confirmed.
  const isCommunity = computed(() => profile === 'community' || edition !== 'ee')
  const isManaged = computed(() => profile === 'managed')
  const isDedicated = computed(() => profile === 'dedicated')
  const isOnPremise = computed(() => profile === 'on-premise')

  /**
   * True when the managed billing surface (checkout, portal, plan
   * modal, trial banner) should be available. False in community
   * and in on-premise deployments. On dedicated with flat billing
   * the subscription UI is also hidden unless Polar/Stripe are
   * configured.
   */
  const hasManagedBilling = computed(() =>
    billingMode === 'polar' || billingMode === 'stripe',
  )

  /**
   * True when the operator decides plan tier by updating
   * workspaces.plan directly (on-premise, dedicated-flat). UIs that
   * surface plan information should be read-only in this case.
   */
  const isOperatorManagedPlan = computed(() =>
    isOnPremise.value || (isDedicated.value && !hasManagedBilling.value),
  )

  return {
    profile,
    edition,
    billingMode,
    isCommunity,
    isManaged,
    isDedicated,
    isOnPremise,
    hasManagedBilling,
    isOperatorManagedPlan,
  }
}
