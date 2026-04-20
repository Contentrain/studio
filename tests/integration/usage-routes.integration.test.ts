import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('usage API', () => {
  function mockAuth() {
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1', email: 'test@test.com' },
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

  describe('GET /usage', () => {
    it('returns usage metrics for all categories', async () => {
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({
          id: 'ws-1',
          plan: 'pro',
          overage_settings: { ai_messages: true },
          media_storage_bytes: 2 * 1024 * 1024 * 1024, // 2 GB
        }),
        getWorkspaceMonthlyAIUsage: vi.fn().mockResolvedValue(45),
        getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(10),
        countMonthlySubmissions: vi.fn().mockResolvedValue(80),
        getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(500 * 1024 * 1024), // 500 MB
        getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
      }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
      const result = await handler({} as never)

      expect(result.billingPeriod).toMatch(/^\d{4}-\d{2}$/)
      expect(result.categories).toHaveLength(6)

      // AI Messages: 45/1500 = 3%
      const ai = result.categories.find((c: { key: string }) => c.key === 'ai_messages')
      expect(ai).toMatchObject({
        key: 'ai_messages',
        current: 45,
        limit: 1500,
        overageEnabled: true,
        overageUnits: 0,
        percentage: 3,
      })

      // Form submissions: 80/3000 ≈ 3%
      const forms = result.categories.find((c: { key: string }) => c.key === 'form_submissions')
      expect(forms).toMatchObject({
        key: 'form_submissions',
        current: 80,
        limit: 3000,
      })
      expect(forms.percentage).toBeGreaterThanOrEqual(2)
      expect(forms.percentage).toBeLessThanOrEqual(3)

      // Media storage: 2GB/15GB ≈ 13%
      const storage = result.categories.find((c: { key: string }) => c.key === 'media_storage')
      expect(storage).toMatchObject({
        key: 'media_storage',
        current: 2,
        limit: 15,
      })
      expect(storage.percentage).toBeGreaterThanOrEqual(13)
      expect(storage.percentage).toBeLessThanOrEqual(14)
    })

    it('calculates overage units when usage exceeds limit', async () => {
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({
          id: 'ws-1',
          plan: 'starter',
          overage_settings: { ai_messages: true },
          media_storage_bytes: 0,
        }),
        getWorkspaceMonthlyAIUsage: vi.fn().mockResolvedValue(175), // 175 > 150 starter limit
        getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(0),
        countMonthlySubmissions: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
      }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
      const result = await handler({} as never)

      const ai = result.categories.find((c: { key: string }) => c.key === 'ai_messages')
      expect(ai).toMatchObject({
        current: 175,
        limit: 150,
        overageUnits: 25,
        overageUnitPrice: 0.03,
        overageAmount: 0.75, // 25 * $0.03
      })
      expect(ai.percentage).toBeGreaterThanOrEqual(116)
      expect(ai.percentage).toBeLessThanOrEqual(117)

      expect(result.totalOverageAmount).toBe(0.75)
    })

    it('returns -1 for unlimited limits (enterprise)', async () => {
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({
          id: 'ws-1',
          plan: 'enterprise',
          overage_settings: {},
          media_storage_bytes: 0,
        }),
        getWorkspaceMonthlyAIUsage: vi.fn().mockResolvedValue(1000),
        getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(0),
        countMonthlySubmissions: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
      }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
      const result = await handler({} as never)

      const ai = result.categories.find((c: { key: string }) => c.key === 'ai_messages')
      expect(ai).toMatchObject({
        limit: -1,
        overageUnits: 0,
        percentage: 0,
      })
    })

    it('returns zero usage for fresh workspace', async () => {
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({
          id: 'ws-1',
          plan: 'starter',
          overage_settings: {},
          media_storage_bytes: 0,
        }),
        getWorkspaceMonthlyAIUsage: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(0),
        countMonthlySubmissions: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
      }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
      const result = await handler({} as never)

      expect(result.totalOverageAmount).toBe(0)
      expect(result.projectedOverageAmount).toBe(0)
      for (const cat of result.categories) {
        expect(cat.overageUnits).toBe(0)
      }
    })

    it('rejects non-owner/admin', async () => {
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue(null),
      }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
      await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('GET /overage-history', () => {
    it('returns overage billing log entries', async () => {
      const mockEntries = [
        { id: 'log-1', billing_period: '2026-03', category: 'ai_messages', units_billed: 25, unit_price: 0.03, total_amount: 0.75 },
      ]

      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1' }),
        getOverageBillingLog: vi.fn().mockResolvedValue(mockEntries),
      }))
      vi.stubGlobal('getQuery', vi.fn().mockReturnValue({ period: '2026-03' }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-history.get.ts')).default
      const result = await handler({} as never)

      expect(result.billingPeriod).toBe('2026-03')
      expect(result.entries).toEqual(mockEntries)
    })

    it('defaults to current month when no period specified', async () => {
      const getOverageBillingLog = vi.fn().mockResolvedValue([])
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1' }),
        getOverageBillingLog,
      }))
      vi.stubGlobal('getQuery', vi.fn().mockReturnValue({}))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/overage-history.get.ts')).default
      const result = await handler({} as never)

      expect(result.billingPeriod).toMatch(/^\d{4}-\d{2}$/)
      expect(getOverageBillingLog).toHaveBeenCalledWith('ws-1', expect.stringMatching(/^\d{4}-\d{2}$/))
    })
  })
})
