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
        // BYOA turns are read separately and never folded into the credits.
        getWorkspaceMonthlyAIUsage: vi.fn(async (_ws: string, _month: string, source?: string) => source === 'byoa' ? 4 : 35),
        getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(10),
        countMonthlySubmissions: vi.fn().mockResolvedValue(80),
        countMonthlyComments: vi.fn().mockResolvedValue(12),
        getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(500 * 1024 * 1024), // 500 MB
        getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
      }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
      const result = await handler({} as never)

      expect(result.billingPeriod).toMatch(/^\d{4}-\d{2}$/)
      expect(result.categories).toHaveLength(7)

      const comments = result.categories.find((c: { key: string }) => c.key === 'comments')
      expect(comments).toMatchObject({ key: 'comments', limitKey: 'comments.per_month', current: 12, unit: 'comments', overageEnabled: false, overageUnitPrice: 0 })

      // AI Messages: 35/350 = 10%
      const ai = result.categories.find((c: { key: string }) => c.key === 'ai_messages')
      expect(ai).toMatchObject({
        key: 'ai_messages',
        current: 35,
        limit: 350,
        overageEnabled: true,
        overageUnits: 0,
        percentage: 10,
      })

      expect(result.byoaRequests).toBe(4)

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
        getWorkspaceMonthlyAIUsage: vi.fn().mockResolvedValue(120), // 120 > 60 starter limit
        getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(0),
        countMonthlySubmissions: vi.fn().mockResolvedValue(0),
        countMonthlyComments: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
      }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
      const result = await handler({} as never)

      const ai = result.categories.find((c: { key: string }) => c.key === 'ai_messages')
      expect(ai).toMatchObject({
        current: 120,
        limit: 60,
        overageUnits: 60,
        overageUnitPrice: 0.08,
        overageAmount: 4.8, // 60 credits x $0.08
      })
      expect(ai.percentage).toBe(200)

      expect(result.totalOverageAmount).toBe(4.8)
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
        countMonthlyComments: vi.fn().mockResolvedValue(0),
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
        countMonthlyComments: vi.fn().mockResolvedValue(0),
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
})
