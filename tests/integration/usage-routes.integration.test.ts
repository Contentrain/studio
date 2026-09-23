import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

    it('shows comments as a fixed limit: there is no overage price to sell them on', async () => {
      // Comments have no meter and no overage price. Offering the switch
      // only produced a 400 from the settings route (no such key).
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', plan: 'pro', overage_settings: {}, media_storage_bytes: 0 }),
        getWorkspaceMonthlyAIUsage: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(0),
        countMonthlySubmissions: vi.fn().mockResolvedValue(0),
        countMonthlyComments: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(0),
        getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
      }))

      const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
      const result = await handler({} as never)

      const comments = result.categories.find((c: { key: string }) => c.key === 'comments')
      expect(comments).toMatchObject({ overageSellable: false, overageEnabled: false })
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

describe('usage API — what the billing screen may claim (BR-12)', () => {
  const NOW = new Date('2026-09-23T12:00:00Z')

  function db(overrides: Record<string, unknown> = {}) {
    return {
      getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', plan: 'pro', overage_settings: {}, media_storage_bytes: 0 }),
      // Billed from the 15th: AI, API and MCP reset on the 15th, forms/comments/CDN on the 1st.
      getActivePaymentAccount: vi.fn().mockResolvedValue({
        subscription_status: 'active',
        current_period_start: '2026-09-15T00:00:00Z',
        current_period_end: '2026-10-15T00:00:00Z',
      }),
      getWorkspaceMonthlyAIUsage: vi.fn(async (_ws: string, _k: string, source?: string) => source === 'byoa' ? 0 : 1036),
      getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(0),
      countMonthlySubmissions: vi.fn().mockResolvedValue(3100),
      countMonthlyComments: vi.fn().mockResolvedValue(0),
      getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(0),
      getWorkspaceMonthlyMcpCloudUsage: vi.fn().mockResolvedValue(0),
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({ user: { id: 'user-1', email: 'a@b.c' }, accessToken: 't' }))
    vi.stubGlobal('getRouterParam', vi.fn(() => 'ws-1'))
    vi.stubGlobal('getQuery', vi.fn(() => ({})))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function run(database: ReturnType<typeof db>) {
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue(database))
    const handler = (await import('../../server/api/workspaces/[workspaceId]/usage.get.ts')).default
    return handler({} as never)
  }

  it('quotes no overage and no projection for meters whose overage is off — they are hard-capped', async () => {
    // Staging, 2026-09-23: 1036 / 350 AI credits with overage off showed
    // "+686 overage ($54.88)" and "Projected overage ~$82.57".
    const result = await run(db())
    const ai = result.categories.find((c: { key: string }) => c.key === 'ai_messages')
    expect(ai).toMatchObject({ current: 1036, limit: 350, overageEnabled: false, overageUnits: 0, overageAmount: 0 })
    expect(result.totalOverageAmount).toBe(0)
    expect(result.projectedOverageAmount).toBe(0)
  })

  it('still tells the owner the unit price before overage is turned on', async () => {
    const result = await run(db())
    const ai = result.categories.find((c: { key: string }) => c.key === 'ai_messages')
    expect(ai.overageUnitPrice).toBe(0.08)
  })

  it('gives each meter its own reset date: billing-period meters on the 15th, calendar meters on the 1st', async () => {
    const result = await run(db())
    const by = (key: string) => result.categories.find((c: { key: string }) => c.key === key)
    expect(by('ai_messages').resetsAt).toBe('2026-10-15T00:00:00.000Z')
    expect(by('mcp_calls').resetsAt).toBe('2026-10-15T00:00:00.000Z')
    expect(by('form_submissions').resetsAt).toBe('2026-10-01T00:00:00.000Z')
    expect(by('comments').resetsAt).toBe('2026-10-01T00:00:00.000Z')
    expect(by('media_storage').resetsAt).toBeNull()
  })

  it('projects only enabled overage, each meter across its own window', async () => {
    // Forms: 3100 by the 23rd of a 30-day calendar month → ~4043 → 1043 over at $0.01.
    const result = await run(db({
      getWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', plan: 'pro', overage_settings: { form_submissions: true }, media_storage_bytes: 0 }),
    }))
    expect(result.totalOverageAmount).toBe(1) // 100 over × $0.01
    expect(result.projectedOverageAmount).toBeGreaterThan(9)
    expect(result.projectedOverageAmount).toBeLessThan(12)
  })

  it('shows a member the meters instead of a 403, without prices or amounts', async () => {
    const database = db({
      getWorkspaceForUser: vi.fn(async (_t: string, _u: string, _w: string, roles?: string[]) =>
        roles?.includes('member') ? { id: 'ws-1', plan: 'pro', overage_settings: { form_submissions: true }, media_storage_bytes: 0 } : null),
    })
    const result = await run(database)
    expect(result.canManage).toBe(false)
    const ai = result.categories.find((c: { key: string }) => c.key === 'ai_messages')
    expect(ai).toMatchObject({ current: 1036, limit: 350, percentage: 296, overageUnitPrice: 0, overageAmount: 0 })
    expect(result.totalOverageAmount).toBe(0)
    expect(result.projectedOverageAmount).toBe(0)
  })

  it('owners and admins can manage', async () => {
    expect((await run(db())).canManage).toBe(true)
  })
})
