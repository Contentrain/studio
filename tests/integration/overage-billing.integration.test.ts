import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('overage billing engine', () => {
  const updateWorkspace = vi.fn().mockResolvedValue({})
  const addInvoiceItem = vi.fn().mockResolvedValue({ invoiceItemId: 'ii_test_123' })
  const createOverageBillingEntry = vi.fn().mockResolvedValue({ id: 'log-1' })
  const hasOverageBeenBilled = vi.fn().mockResolvedValue(false)

  function mockProviders(overrides: {
    plan?: string
    overageSettings?: Record<string, boolean>
    aiUsage?: number
    apiUsage?: number
    formSubmissions?: number
    cdnBandwidth?: number
    storageBytes?: number
  } = {}) {
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      getWorkspaceById: vi.fn().mockResolvedValue({
        id: 'ws-1',
        plan: overrides.plan ?? 'pro',
        overage_settings: overrides.overageSettings ?? { ai_messages: true },
        media_storage_bytes: overrides.storageBytes ?? 0,
      }),
      getWorkspaceMonthlyAIUsage: vi.fn().mockResolvedValue(overrides.aiUsage ?? 0),
      getWorkspaceMonthlyAPIUsage: vi.fn().mockResolvedValue(overrides.apiUsage ?? 0),
      countMonthlySubmissions: vi.fn().mockResolvedValue(overrides.formSubmissions ?? 0),
      getWorkspaceMonthlyCDNBandwidth: vi.fn().mockResolvedValue(overrides.cdnBandwidth ?? 0),
      hasOverageBeenBilled,
      createOverageBillingEntry,
      updateWorkspace,
    }))

    vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
      addInvoiceItem,
    }))
  }

  beforeEach(() => {
    addInvoiceItem.mockClear()
    createOverageBillingEntry.mockClear()
    hasOverageBeenBilled.mockClear().mockResolvedValue(false)
  })

  describe('invoice.creating webhook triggers overage billing', () => {
    it('calculates and bills overage on invoice.creating event', async () => {
      // Setup: AI overage enabled, 550 messages used on pro plan (limit 500)
      mockProviders({ aiUsage: 550, overageSettings: { ai_messages: true } })

      vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({
        handleWebhook: vi.fn().mockResolvedValue({
          event: 'invoice.creating',
          workspaceId: 'ws-1',
          subscriptionId: 'sub_123',
          customerId: 'cus_123',
          requiresOverageCalculation: true,
        }),
        addInvoiceItem,
      }))
      vi.stubGlobal('readRawBody', vi.fn().mockResolvedValue('{}'))
      vi.stubGlobal('getRequestHeader', vi.fn().mockReturnValue('sig_test'))

      const handler = (await import('../../server/api/billing/webhook.post.ts')).default
      const result = await handler({ context: {} } as never)

      expect(result).toEqual({ received: true })

      // Verify addInvoiceItem was called with correct overage amount
      expect(addInvoiceItem).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cus_123',
        subscriptionId: 'sub_123',
        amount: 150, // 50 messages * $0.03 = $1.50 → 150 cents
        description: expect.stringContaining('50'),
      }))

      // Verify billing log entry was created
      expect(createOverageBillingEntry).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-1',
        category: 'ai_messages',
        unitsBilled: 50,
        unitPrice: 0.03,
        totalAmount: 1.5,
        stripeInvoiceItemId: 'ii_test_123',
      }))
    })

    it('skips categories where overage is disabled', async () => {
      mockProviders({
        aiUsage: 550,
        overageSettings: { ai_messages: false },
      })

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      expect(addInvoiceItem).not.toHaveBeenCalled()
    })

    it('skips categories where usage is under limit', async () => {
      mockProviders({
        aiUsage: 30,
        overageSettings: { ai_messages: true },
      })

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      expect(addInvoiceItem).not.toHaveBeenCalled()
    })

    it('prevents double-billing via hasOverageBeenBilled check', async () => {
      mockProviders({ aiUsage: 550, overageSettings: { ai_messages: true } })
      hasOverageBeenBilled.mockResolvedValue(true) // Already billed

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      expect(addInvoiceItem).not.toHaveBeenCalled()
      expect(createOverageBillingEntry).not.toHaveBeenCalled()
    })

    it('skips Infinity limits (enterprise plan)', async () => {
      mockProviders({
        plan: 'enterprise',
        aiUsage: 10000,
        overageSettings: { ai_messages: true },
      })

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      expect(addInvoiceItem).not.toHaveBeenCalled()
    })

    it('bills multiple categories when overages exist', async () => {
      mockProviders({
        plan: 'starter',
        aiUsage: 70, // limit 50 → 20 overage
        formSubmissions: 150, // limit 100 → 50 overage
        overageSettings: { ai_messages: true, form_submissions: true },
      })

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      // Two invoice items should be created
      expect(addInvoiceItem).toHaveBeenCalledTimes(2)
      expect(createOverageBillingEntry).toHaveBeenCalledTimes(2)

      // AI: 20 * $0.03 = $0.60 = 60 cents
      expect(addInvoiceItem).toHaveBeenCalledWith(expect.objectContaining({
        amount: 60,
      }))

      // Forms: 50 * $0.01 = $0.50 = 50 cents
      expect(addInvoiceItem).toHaveBeenCalledWith(expect.objectContaining({
        amount: 50,
      }))
    })

    it('does nothing when payment provider is null', async () => {
      mockProviders({ aiUsage: 550, overageSettings: { ai_messages: true } })
      vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue(null))

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      expect(createOverageBillingEntry).not.toHaveBeenCalled()
    })

    it('does nothing when workspace not found', async () => {
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        getWorkspaceById: vi.fn().mockResolvedValue(null),
      }))
      vi.stubGlobal('usePaymentProvider', vi.fn().mockReturnValue({ addInvoiceItem }))

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      expect(addInvoiceItem).not.toHaveBeenCalled()
    })

    it('does nothing when overage_settings is empty', async () => {
      mockProviders({
        aiUsage: 550,
        overageSettings: {},
      })

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      expect(addInvoiceItem).not.toHaveBeenCalled()
    })

    it('handles CDN bandwidth overage in GB', async () => {
      const twoAndHalfGB = 2.5 * 1024 * 1024 * 1024 // 2.5 GB in bytes
      mockProviders({
        plan: 'starter', // limit 2 GB
        cdnBandwidth: twoAndHalfGB,
        overageSettings: { cdn_bandwidth: true },
      })

      const { calculateAndBillOverages } = await import('../../server/utils/overage-billing')
      await calculateAndBillOverages('ws-1', 'cus_123', 'sub_123')

      // 0.5 GB overage * $0.10 = $0.05 = 5 cents
      expect(addInvoiceItem).toHaveBeenCalledWith(expect.objectContaining({
        amount: 5,
      }))
    })
  })
})
