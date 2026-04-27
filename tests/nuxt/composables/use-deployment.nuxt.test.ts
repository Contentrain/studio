import { beforeEach, describe, expect, it } from 'vitest'
import { useDeployment } from '../../../app/composables/useDeployment'

/**
 * Nuxt auto-imports `useRuntimeConfig` — we mutate its `public`
 * object directly instead of trying to stub the import (the standard
 * `vi.stubGlobal` / `mockNuxtImport` path either collides with Nuxt's
 * internal `setupNuxt` or silently leaves the real import in place).
 * The runtimeConfig returned by `useRuntimeConfig()` in the test
 * environment is a live object that `useDeployment` reads each time
 * the composable is invoked.
 */
function set(deployment: { profile?: string, edition?: string, billingMode?: string } = {}) {
  const cfg = useRuntimeConfig()
  const pub = cfg.public as Record<string, unknown>
  pub.deployment = {
    profile: deployment.profile ?? '',
    edition: deployment.edition ?? '',
    billingMode: deployment.billingMode ?? '',
  }
}

describe('useDeployment', () => {
  beforeEach(() => {
    set()
  })

  it('exposes raw axes', () => {
    set({ profile: 'managed', edition: 'ee', billingMode: 'polar' })
    const d = useDeployment()
    expect(d.profile).toBe('managed')
    expect(d.edition).toBe('ee')
    expect(d.billingMode).toBe('polar')
  })

  it('flags community correctly across profile/edition signals', () => {
    set({ profile: 'community', edition: 'agpl', billingMode: 'off' })
    expect(useDeployment().isCommunity.value).toBe(true)

    set({ profile: 'managed', edition: 'agpl', billingMode: 'off' })
    // Missing ee bridge always means community even if profile was
    // misconfigured — mirrors the server-side guard.
    expect(useDeployment().isCommunity.value).toBe(true)
  })

  it('hasManagedBilling is true only for polar/stripe', () => {
    set({ profile: 'managed', edition: 'ee', billingMode: 'polar' })
    expect(useDeployment().hasManagedBilling.value).toBe(true)

    set({ profile: 'managed', edition: 'ee', billingMode: 'stripe' })
    expect(useDeployment().hasManagedBilling.value).toBe(true)

    set({ profile: 'on-premise', edition: 'ee', billingMode: 'off' })
    expect(useDeployment().hasManagedBilling.value).toBe(false)

    set({ profile: 'community', edition: 'agpl', billingMode: 'off' })
    expect(useDeployment().hasManagedBilling.value).toBe(false)
  })

  it('isOperatorManagedPlan covers on-premise and flat-fee dedicated', () => {
    set({ profile: 'on-premise', edition: 'ee', billingMode: 'off' })
    expect(useDeployment().isOperatorManagedPlan.value).toBe(true)

    set({ profile: 'dedicated', edition: 'ee', billingMode: 'off' })
    expect(useDeployment().isOperatorManagedPlan.value).toBe(true)

    set({ profile: 'dedicated', edition: 'ee', billingMode: 'polar' })
    // Dedicated + polar → subscription-driven, not operator-managed.
    expect(useDeployment().isOperatorManagedPlan.value).toBe(false)

    set({ profile: 'managed', edition: 'ee', billingMode: 'polar' })
    expect(useDeployment().isOperatorManagedPlan.value).toBe(false)

    set({ profile: 'community', edition: 'agpl', billingMode: 'off' })
    expect(useDeployment().isOperatorManagedPlan.value).toBe(false)
  })

  it('treats an empty deployment snapshot as community (fail safe)', () => {
    set()
    const d = useDeployment()
    expect(d.profile).toBe('')
    expect(d.edition).toBe('')
    expect(d.billingMode).toBe('')
    expect(d.isCommunity.value).toBe(true)
    expect(d.hasManagedBilling.value).toBe(false)
  })
})
