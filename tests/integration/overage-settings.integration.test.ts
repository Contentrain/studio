import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('overage settings API', () => {
  const updateWorkspace = vi.fn().mockResolvedValue({})

  function mockDb(overrides: {
    workspace?: Record<string, unknown>
    paymentAccount?: Record<string, unknown> | null
  } = {}) {
    const defaultWorkspace = {
      id: 'ws-1',
      plan: 'pro',
      overage_settings: {},
    }
    const defaultAccount = {
      provider: 'polar',
      customer_id: 'cus_123',
      subscription_id: 'sub_123',
      subscription_status: 'active',
    }
    const getWorkspaceForUser = vi.fn().mockResolvedValue({ ...defaultWorkspace, ...(overrides.workspace ?? {}) })
    const getActivePaymentAccount = vi.fn().mockResolvedValue(
      overrides.paymentAccount === null ? null : { ...defaultAccount, ...(overrides.paymentAccount ?? {}) },
    )
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceForUser,
      getActivePaymentAccount,
      updateWorkspace,
    }))
    return { getWorkspaceForUser, getActivePaymentAccount }
  }

  function mockAuth(userId = 'user-1') {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: userId, email: 'test@test.com' },
      accessToken: 'token-1',
    }))
  }

  beforeEach(() => {
    mockAuth()
    vi.stubGlobal('getRouterParam', vi.fn((_: unknown, key: string) => {
      if (key === 'workspaceId') return 'ws-1'
      return undefined
    }))
  })

  describe('GET /overage-settings', () => {
    it('returns overage settings with pricing for each category, in a pre-v2 account\'s own terms', async () => {
      mockDb({ workspace: { overage_settings: { ai_messages: true, cdn_bandwidth: false } }, paymentAccount: { credit_unit: '0.03' } })

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.get.ts')).default
      const result = await handler({} as never)

      expect(result.overageSettings).toEqual({ ai_messages: true, cdn_bandwidth: false })
      expect(result.categories).toBeInstanceOf(Array)
      expect(result.categories.length).toBe(6)

      const aiCategory = result.categories.find((c: { settingsKey: string }) => c.settingsKey === 'ai_messages')
      expect(aiCategory).toMatchObject({
        limitKey: 'ai.messages_per_month',
        settingsKey: 'ai_messages',
        unitPrice: 0.08,
        planLimit: 350, // pro plan
        enabled: true,
      })
    })

    it('shows a v2 account the catalog v2 credit price and quota', async () => {
      mockDb({ workspace: { overage_settings: { ai_messages: true } }, paymentAccount: { credit_unit: '0.01' } })
      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.get.ts')).default
      const result = await handler({} as never)
      const ai = result.categories.find((c: { settingsKey: string }) => c.settingsKey === 'ai_messages')
      expect(ai).toMatchObject({ unitPrice: 0.025, planLimit: 1600 })
      const mcp = result.categories.find((c: { settingsKey: string }) => c.settingsKey === 'mcp_calls')
      expect(mcp).toMatchObject({ unitPrice: 0.001 })
    })

    it('returns canEnableOverage=true when subscription active with payment method', async () => {
      mockDb({
        workspace: { plan: 'pro' },
        paymentAccount: { subscription_status: 'active', customer_id: 'cus_123' },
      })

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.get.ts')).default
      const result = await handler({} as never)

      expect(result.canEnableOverage).toBe(true)
    })

    it('reports a locked toggle as off, with why and until when', async () => {
      mockDb({
        workspace: { overage_settings: { ai_messages: true } },
        paymentAccount: { subscription_status: 'trialing', trial_ends_at: '2026-09-29T07:36:51.653Z' },
      })

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.get.ts')).default
      const result = await handler({} as never)

      const ai = result.categories.find((c: { settingsKey: string }) => c.settingsKey === 'ai_messages')
      expect(ai).toMatchObject({ enabled: false, lock: { reason: 'trialing', until: '2026-09-29T07:36:51.653Z' } })
    })

    it('returns canEnableOverage=false for free plan', async () => {
      mockDb({ workspace: { plan: 'free' }, paymentAccount: null })

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.get.ts')).default
      const result = await handler({} as never)

      expect(result.canEnableOverage).toBe(false)
    })

    it('rejects non-owner/admin', async () => {
      const { getWorkspaceForUser } = mockDb()
      getWorkspaceForUser.mockResolvedValue(null) // role check fails

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.get.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('PATCH /overage-settings', () => {
    it('merges new settings with existing', async () => {
      mockDb({ workspace: { overage_settings: { ai_messages: true } } })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ form_submissions: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      const result = await handler({} as never)

      expect(result.overageSettings).toEqual({ ai_messages: true, form_submissions: true })
      expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', {
        overage_settings: { ai_messages: true, form_submissions: true },
      })
    })

    it('refuses to enable a limit that is not sold', async () => {
      // CDN bandwidth and media storage are hard limits: the meter counts
      // bytes, so Polar cannot carry the plan's gigabyte allowance and
      // overage would bill the included gigabytes as well.
      mockDb()
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ cdn_bandwidth: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 409 })
      expect(updateWorkspace).not.toHaveBeenCalled()
    })

    it('still lets a stale hard-limit toggle be turned off', async () => {
      // Refusing `false` too would trap a workspace that has a stale
      // `true` stored from before the limit became hard.
      mockDb({ workspace: { overage_settings: { cdn_bandwidth: true } } })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ cdn_bandwidth: false }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      const result = await handler({} as never)

      expect(result.overageSettings).toEqual({ cdn_bandwidth: false })
    })

    it('can disable an existing overage category', async () => {
      mockDb({ workspace: { overage_settings: { ai_messages: true, cdn_bandwidth: true } } })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: false }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      const result = await handler({} as never)

      expect(result.overageSettings).toEqual({ ai_messages: false, cdn_bandwidth: true })
    })

    it('rejects invalid settings key', async () => {
      mockDb()
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ invalid_key: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects non-boolean value', async () => {
      mockDb()
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: 'yes' }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects when no active subscription', async () => {
      mockDb({ paymentAccount: null })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 402 })
    })

    it('rejects for free plan workspace', async () => {
      mockDb({
        workspace: { plan: 'free' },
        paymentAccount: { subscription_status: 'active', customer_id: 'cus_123' },
      })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 403 })
    })

    it('refuses to turn overage on during a trial, and says when it can be', async () => {
      mockDb({ paymentAccount: { subscription_status: 'trialing', trial_ends_at: '2026-09-29T07:36:51.653Z' } })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({
        statusCode: 409,
        data: { code: 'overage_locked', reason: 'trialing', until: '2026-09-29T07:36:51.653Z' },
      })
      expect(updateWorkspace).not.toHaveBeenCalled()
    })

    it('refuses overage on a meter the subscription has no price for', async () => {
      // A subscription created before the credit meters keeps its old
      // prices: usage past the limit would be consumed and never invoiced.
      mockDb({ paymentAccount: { plugin_metadata: { billable_meters: ['ai_messages', 'api_messages', 'mcp_calls', 'form_submissions'] } } })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({
        statusCode: 409,
        data: { code: 'overage_locked', reason: 'not_in_subscription' },
      })
      expect(updateWorkspace).not.toHaveBeenCalled()
    })

    it('allows overage on a meter the subscription prices', async () => {
      mockDb({ paymentAccount: { plugin_metadata: { billable_meters: ['ai_messages', 'api_messages', 'mcp_calls', 'form_submissions'] } } })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ mcp_calls: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).resolves.toEqual({ overageSettings: { mcp_calls: true } })
    })

    it('always lets a locked toggle be turned off', async () => {
      mockDb({
        workspace: { overage_settings: { ai_messages: true } },
        paymentAccount: { subscription_status: 'trialing' },
      })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: false }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).resolves.toEqual({ overageSettings: { ai_messages: false } })
    })

    it('rejects empty body', async () => {
      mockDb()
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({}))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    })
  })
})
