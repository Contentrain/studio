import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('overage settings API', () => {
  const updateWorkspace = vi.fn().mockResolvedValue({})

  function mockDb(overrides: Record<string, unknown> = {}) {
    const getWorkspaceForUser = vi.fn().mockResolvedValue({
      id: 'ws-1',
      plan: 'pro',
      overage_settings: {},
      stripe_customer_id: 'cus_123',
      subscription_status: 'active',
      ...overrides,
    })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceForUser,
      updateWorkspace,
    }))
    return { getWorkspaceForUser }
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
    it('returns overage settings with pricing for each category', async () => {
      mockDb({ overage_settings: { ai_messages: true, cdn_bandwidth: false } })

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.get.ts')).default
      const result = await handler({} as never)

      expect(result.overageSettings).toEqual({ ai_messages: true, cdn_bandwidth: false })
      expect(result.categories).toBeInstanceOf(Array)
      expect(result.categories.length).toBe(6)

      const aiCategory = result.categories.find((c: { settingsKey: string }) => c.settingsKey === 'ai_messages')
      expect(aiCategory).toMatchObject({
        limitKey: 'ai.messages_per_month',
        settingsKey: 'ai_messages',
        unitPrice: 0.03,
        planLimit: 1500, // pro plan
        enabled: true,
      })
    })

    it('returns canEnableOverage=true when subscription active with payment method', async () => {
      mockDb({
        stripe_customer_id: 'cus_123',
        subscription_status: 'active',
        plan: 'pro',
      })

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.get.ts')).default
      const result = await handler({} as never)

      expect(result.canEnableOverage).toBe(true)
    })

    it('returns canEnableOverage=false for free plan', async () => {
      mockDb({ plan: 'free', stripe_customer_id: null, subscription_status: null })

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
      mockDb({ overage_settings: { ai_messages: true } })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ cdn_bandwidth: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      const result = await handler({} as never)

      expect(result.overageSettings).toEqual({ ai_messages: true, cdn_bandwidth: true })
      expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', {
        overage_settings: { ai_messages: true, cdn_bandwidth: true },
      })
    })

    it('can disable an existing overage category', async () => {
      mockDb({ overage_settings: { ai_messages: true, cdn_bandwidth: true } })
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
      mockDb({ subscription_status: null, stripe_customer_id: null })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 402 })
    })

    it('rejects for free plan workspace', async () => {
      mockDb({ plan: 'free', subscription_status: 'active', stripe_customer_id: 'cus_123' })
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({ ai_messages: true }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 403 })
    })

    it('rejects empty body', async () => {
      mockDb()
      vi.stubGlobal('readBody', vi.fn().mockResolvedValue({}))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-settings.patch.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    })
  })
})
