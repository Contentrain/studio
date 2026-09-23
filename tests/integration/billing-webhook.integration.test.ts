import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string, data?: unknown }) {
  return Object.assign(new Error(input.message), input)
}

/**
 * The per-provider webhook route accepts a `WebhookResult` from the plugin's
 * `handleWebhook`. These tests stub the plugin registry and the database so
 * we can assert the DB writes triggered by each canonical event type.
 */
describe('billing webhook integration', () => {
  const upsertPaymentAccount = vi.fn().mockResolvedValue({})
  const archiveActivePaymentAccount = vi.fn().mockResolvedValue(undefined)
  const updateWorkspace = vi.fn().mockResolvedValue({})
  const getActivePaymentAccount = vi.fn().mockResolvedValue(null)
  const markWorkspaceTrialConsumed = vi.fn().mockResolvedValue(undefined)
  // No marker is stored: activation claims (pending → sent) find nothing,
  // a recovery claim (new episode) wins. The activation tests use a store.
  const claimDefault = async ({ when }: { when: unknown }) => when === 'different'
  const setPaymentAccountMetadataKey = vi.fn(claimDefault)

  let handleWebhookMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    handleWebhookMock = vi.fn()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('readRawBody', vi.fn().mockResolvedValue('{}'))
    vi.stubGlobal('getRequestHeaders', vi.fn().mockReturnValue({}))
    vi.stubGlobal('getRouterParam', vi.fn().mockReturnValue('stripe'))
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({ stripe: { secretKey: 'sk_mock' } }))
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      upsertPaymentAccount,
      archiveActivePaymentAccount,
      updateWorkspace,
      getActivePaymentAccount,
      markWorkspaceTrialConsumed,
      setPaymentAccountMetadataKey,
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    upsertPaymentAccount.mockReset().mockResolvedValue({})
    archiveActivePaymentAccount.mockReset().mockResolvedValue(undefined)
    updateWorkspace.mockReset().mockResolvedValue({})
    getActivePaymentAccount.mockReset().mockResolvedValue(null)
    markWorkspaceTrialConsumed.mockReset().mockResolvedValue(undefined)
    setPaymentAccountMetadataKey.mockReset().mockImplementation(claimDefault)
  })

  async function mockPluginAndLoadHandler(options: { configured?: boolean } = {}) {
    const paymentModule = await import('../../server/providers/payment')
    // Flip the bootstrap flag first so the route's lazy bootstrap call is a
    // no-op, then swap the registered Stripe plugin for our mock.
    paymentModule.bootstrapPaymentPlugins()
    const { __resetRegistryForTests } = await import('../../server/providers/payment/registry')
    __resetRegistryForTests()
    paymentModule.registerPlugin({
      key: 'stripe',
      label: 'Stripe',
      isConfigured: () => options.configured ?? true,
      create: () => ({
        createCheckoutSession: vi.fn(),
        createPortalSession: vi.fn(),
        handleWebhook: handleWebhookMock,
        cancelSubscription: vi.fn(),
        ingestUsageEvent: vi.fn(),
      }),
    })
    return (await import('../../server/api/billing/webhook/[provider].post.ts')).default
  }

  it('activates subscription on subscription.created', async () => {
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.created',
      workspaceId: 'ws-1',
      plan: 'pro',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'trialing',
      currentPeriodEnd: '2026-04-16T00:00:00.000Z',
      trialEndsAt: '2026-04-16T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    })

    const handler = await mockPluginAndLoadHandler()
    const result = await handler({ context: {} } as never)

    expect(result).toEqual({ received: true })
    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      provider: 'stripe',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'trialing',
      trialEndsAt: '2026-04-16T00:00:00.000Z',
      plan: 'pro',
      isActive: true,
    }))
    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { plan: 'pro' })
    // Trialing subscription consumes the workspace's one-time trial.
    expect(markWorkspaceTrialConsumed).toHaveBeenCalledWith('ws-1')
  })

  it('updates plan on subscription.updated (portal plan change)', async () => {
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.updated',
      workspaceId: 'ws-1',
      plan: 'starter',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'active',
      currentPeriodEnd: '2026-05-02T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      subscriptionStatus: 'active',
      trialEndsAt: null,
      gracePeriodEndsAt: null,
      plan: 'starter',
    }))
    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({
      plan: 'starter',
      trial_reminder_stage: 0,
    }))
    // Active (non-trialing) subscription must NOT consume a trial.
    expect(markWorkspaceTrialConsumed).not.toHaveBeenCalled()
  })

  it('keeps the real trial_end on a trialing plan change (no billing-period-end stamp)', async () => {
    // Existing Starter trial ends in ~14 days.
    getActivePaymentAccount.mockResolvedValue({
      subscription_status: 'trialing',
      trial_ends_at: '2026-04-16T00:00:00.000Z',
    })
    // Portal upgrade to Pro keeps the trial; the provider omits trial_end on
    // the update event and reports a far-future (annual) period end.
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.updated',
      workspaceId: 'ws-1',
      plan: 'pro',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'trialing',
      currentPeriodEnd: '2027-04-02T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionStatus: 'trialing',
      // Original 14-day trial end is preserved — NOT the +1y period end.
      trialEndsAt: '2026-04-16T00:00:00.000Z',
      plan: 'pro',
    }))
  })

  it('uses up the Migrate grant a subscription was started from', async () => {
    const markMigrateGrantRedeemed = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      upsertPaymentAccount,
      archiveActivePaymentAccount,
      updateWorkspace,
      getActivePaymentAccount,
      markWorkspaceTrialConsumed,
      setPaymentAccountMetadataKey,
      markMigrateGrantRedeemed,
    }))
    const created = {
      event: 'subscription.created',
      workspaceId: 'ws-1',
      plan: 'pro',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'trialing',
      trialEndsAt: '2026-11-22T12:00:00.000Z',
      cancelAtPeriodEnd: false,
    }
    handleWebhookMock.mockResolvedValue({ ...created, migrateGrantId: 'grant-1' })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)
    expect(markMigrateGrantRedeemed).toHaveBeenCalledWith('grant-1', 'sub_123')
    // The trial cap tells a Migrate trial apart by this mark.
    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      pluginMetadata: expect.objectContaining({ trial_origin: 'migrate' }),
    }))

    // An ordinary subscription touches no grant and carries no mark.
    markMigrateGrantRedeemed.mockClear()
    upsertPaymentAccount.mockClear()
    handleWebhookMock.mockResolvedValue(created)
    await handler({ context: {} } as never)
    expect(markMigrateGrantRedeemed).not.toHaveBeenCalled()
    const written = upsertPaymentAccount.mock.calls[0]![0] as { pluginMetadata?: Record<string, unknown> }
    expect(written.pluginMetadata?.trial_origin).toBeUndefined()
  })

  it('keeps the Migrate mark next to what the account already records', async () => {
    getActivePaymentAccount.mockResolvedValue({
      subscription_id: 'sub_123',
      subscription_status: 'trialing',
      trial_ends_at: '2026-11-22T12:00:00.000Z',
      plugin_metadata: { billable_meters: ['ai_credits', 'api_credits'] },
    })
    vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
      upsertPaymentAccount,
      archiveActivePaymentAccount,
      updateWorkspace,
      getActivePaymentAccount,
      markWorkspaceTrialConsumed,
      setPaymentAccountMetadataKey,
      markMigrateGrantRedeemed: vi.fn().mockResolvedValue(undefined),
    }))
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.updated',
      workspaceId: 'ws-1',
      plan: 'pro',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'active',
      cancelAtPeriodEnd: false,
      migrateGrantId: 'grant-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      pluginMetadata: { billable_meters: ['ai_credits', 'api_credits'], trial_origin: 'migrate' },
    }))
  })

  it('downgrades to free on subscription.canceled', async () => {
    handleWebhookMock.mockResolvedValue({
      event: 'subscription.canceled',
      workspaceId: 'ws-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(archiveActivePaymentAccount).toHaveBeenCalledWith('ws-1')
    expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({
      plan: 'free',
      trial_reminder_stage: 0,
    }))
  })

  it('sets grace period on first invoice.payment_failed', async () => {
    getActivePaymentAccount.mockResolvedValue({
      provider: 'stripe',
      customer_id: 'cus_123',
      subscription_id: 'sub_123',
      subscription_status: 'active',
      current_period_end: '2026-05-01T00:00:00.000Z',
      trial_ends_at: null,
      grace_period_ends_at: null,
      cancel_at_period_end: false,
      plan: 'pro',
    })
    handleWebhookMock.mockResolvedValue({
      event: 'invoice.payment_failed',
      workspaceId: 'ws-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionStatus: 'past_due',
      gracePeriodEndsAt: expect.any(String),
    }))
  })

  it('does NOT collapse trialing to active on invoice.paid ($0 trial invoice)', async () => {
    getActivePaymentAccount.mockResolvedValue({
      provider: 'stripe',
      customer_id: 'cus_123',
      subscription_id: 'sub_123',
      subscription_status: 'trialing',
    })
    handleWebhookMock.mockResolvedValue({
      event: 'invoice.paid',
      workspaceId: 'ws-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    // Should not push any update when subscription is still trialing
    expect(upsertPaymentAccount).not.toHaveBeenCalled()
  })

  it('restores active on invoice.paid when past_due (payment recovery)', async () => {
    getActivePaymentAccount.mockResolvedValue({
      provider: 'stripe',
      customer_id: 'cus_123',
      subscription_id: 'sub_123',
      subscription_status: 'past_due',
      current_period_end: '2026-05-01T00:00:00.000Z',
      trial_ends_at: null,
      grace_period_ends_at: '2026-04-28T00:00:00.000Z',
      cancel_at_period_end: false,
      plan: 'pro',
    })
    handleWebhookMock.mockResolvedValue({
      event: 'invoice.paid',
      workspaceId: 'ws-1',
    })

    const handler = await mockPluginAndLoadHandler()
    await handler({ context: {} } as never)

    expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionStatus: 'active',
      gracePeriodEndsAt: null,
    }))
  })

  describe('trial end and overage the subscription cannot bill', () => {
    const getWorkspaceById = vi.fn()
    const LEGACY_PRICES = ['ai_messages', 'api_messages', 'cdn_bandwidth_bytes', 'form_submissions', 'mcp_calls', 'media_storage_byte_hours']
    const CURRENT_PRICES = ['ai_credits', 'api_credits', 'form_submissions', 'mcp_calls']

    beforeEach(() => {
      getWorkspaceById.mockReset().mockResolvedValue({ id: 'ws-1', overage_settings: {} })
      vi.stubGlobal('useEmailProvider', vi.fn().mockReturnValue(null))
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        upsertPaymentAccount,
        archiveActivePaymentAccount,
        updateWorkspace,
        getActivePaymentAccount,
        markWorkspaceTrialConsumed,
        setPaymentAccountMetadataKey,
        getWorkspaceById,
      }))
    })

    it('moves the usage window to the paid period when the trial ends', async () => {
      // Pro trial 15 → 29 Sep; the provider renews into 29 Sep → 29 Oct.
      getActivePaymentAccount.mockResolvedValue({
        subscription_status: 'trialing',
        current_period_start: '2026-09-15T07:36:51.653Z',
        current_period_end: '2026-09-29T07:36:51.653Z',
        trial_ends_at: '2026-09-29T07:36:51.653Z',
        plugin_metadata: {},
      })
      handleWebhookMock.mockResolvedValue({
        event: 'subscription.updated',
        workspaceId: 'ws-1',
        plan: 'pro',
        customerId: 'cus_123',
        subscriptionId: 'sub_123',
        subscriptionStatus: 'active',
        currentPeriodStart: '2026-09-29T07:36:51.653Z',
        currentPeriodEnd: '2026-10-29T07:36:51.653Z',
        billableMeters: CURRENT_PRICES,
      })

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionStatus: 'active',
        currentPeriodStart: '2026-09-29T07:36:51.653Z',
        currentPeriodEnd: '2026-10-29T07:36:51.653Z',
        trialEndsAt: null,
      }))

      // The quota key the gates count in follows the stored row: the trial's
      // window before, the first paid period after — so the paid period
      // starts from zero.
      const { usagePeriodFrom } = await import('../../server/utils/usage-period')
      const written = upsertPaymentAccount.mock.calls[0]![0] as { currentPeriodStart: string, currentPeriodEnd: string, subscriptionStatus: string }
      const now = new Date('2026-09-30T12:00:00.000Z')
      expect(usagePeriodFrom({
        subscription_status: 'trialing',
        current_period_start: '2026-09-15T07:36:51.653Z',
        current_period_end: '2026-09-29T07:36:51.653Z',
      }, new Date('2026-09-20T00:00:00.000Z')).key).toBe('2026-09-15')
      expect(usagePeriodFrom({
        subscription_status: written.subscriptionStatus,
        current_period_start: written.currentPeriodStart,
        current_period_end: written.currentPeriodEnd,
      }, now).key).toBe('2026-09-29')
    })

    it('turns off and remembers overage a legacy-priced subscription cannot bill', async () => {
      getWorkspaceById.mockResolvedValue({ id: 'ws-1', overage_settings: { ai_messages: true, mcp_calls: true } })
      getActivePaymentAccount.mockResolvedValue({ subscription_status: 'trialing', plugin_metadata: {} })
      handleWebhookMock.mockResolvedValue({
        event: 'subscription.updated',
        workspaceId: 'ws-1',
        plan: 'pro',
        customerId: 'cus_123',
        subscriptionId: 'sub_123',
        subscriptionStatus: 'active',
        currentPeriodStart: '2026-09-29T07:36:51.653Z',
        currentPeriodEnd: '2026-10-29T07:36:51.653Z',
        billableMeters: LEGACY_PRICES,
      })

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
        pluginMetadata: { billable_meters: LEGACY_PRICES, overage_suspended: ['ai_messages'] },
        preserveMetadataKeys: ['activation_email', 'recovery_email'],
      }))
      // Trial → active also marks the activation email owed (it goes out on the first paid order).
      expect(setPaymentAccountMetadataKey).toHaveBeenCalledWith({ workspaceId: 'ws-1', key: 'activation_email', value: 'pending', when: 'absent' })
      expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { overage_settings: { ai_messages: false, mcp_calls: true } })
    })

    it('turns suspended overage back on once the subscription is on current prices', async () => {
      getWorkspaceById.mockResolvedValue({ id: 'ws-1', overage_settings: { ai_messages: false, mcp_calls: true } })
      getActivePaymentAccount.mockResolvedValue({
        subscription_status: 'active',
        plugin_metadata: { billable_meters: LEGACY_PRICES, overage_suspended: ['ai_messages'] },
      })
      handleWebhookMock.mockResolvedValue({
        event: 'subscription.updated',
        workspaceId: 'ws-1',
        plan: 'pro',
        customerId: 'cus_123',
        subscriptionId: 'sub_123',
        subscriptionStatus: 'active',
        currentPeriodStart: '2026-09-29T07:36:51.653Z',
        currentPeriodEnd: '2026-10-29T07:36:51.653Z',
        billableMeters: CURRENT_PRICES,
      })

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
        pluginMetadata: { billable_meters: CURRENT_PRICES },
      }))
      expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { overage_settings: { ai_messages: true, mcp_calls: true } })
    })

    it('suspends overage on a new trial', async () => {
      getWorkspaceById.mockResolvedValue({ id: 'ws-1', overage_settings: { api_messages: true } })
      handleWebhookMock.mockResolvedValue({
        event: 'subscription.created',
        workspaceId: 'ws-1',
        plan: 'starter',
        customerId: 'cus_123',
        subscriptionId: 'sub_123',
        subscriptionStatus: 'trialing',
        trialEndsAt: '2026-10-05T08:06:40.869Z',
        billableMeters: CURRENT_PRICES,
      })

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(updateWorkspace).toHaveBeenCalledWith('', 'ws-1', { overage_settings: { api_messages: false } })
      expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
        pluginMetadata: { billable_meters: CURRENT_PRICES, overage_suspended: ['api_messages'] },
      }))
    })

    it('keeps the stored price list on a payment event', async () => {
      getActivePaymentAccount.mockResolvedValue({
        provider: 'stripe',
        customer_id: 'cus_123',
        subscription_id: 'sub_123',
        subscription_status: 'past_due',
        plugin_metadata: { billable_meters: LEGACY_PRICES },
      })
      handleWebhookMock.mockResolvedValue({ event: 'invoice.paid', workspaceId: 'ws-1' })

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      // Omitted → the provider keeps the stored value (see DatabaseProvider).
      expect(upsertPaymentAccount.mock.calls[0]![0]).not.toHaveProperty('pluginMetadata')
    })
  })

  it('returns 503 when provider is not configured', async () => {
    const handler = await mockPluginAndLoadHandler({ configured: false })
    await expect(handler({ context: {} } as never)).rejects.toMatchObject({
      statusCode: 503,
    })
  })

  it('returns 404 for unknown provider', async () => {
    vi.stubGlobal('getRouterParam', vi.fn().mockReturnValue('unknown'))
    const handler = await mockPluginAndLoadHandler()
    await expect(handler({ context: {} } as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  describe('paid access and payment problems', () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined)

    /** Route the owner emails to `sendEmail` so each test can see what went out. */
    function captureEmails() {
      sendEmail.mockClear()
      vi.stubGlobal('useEmailProvider', () => ({ sendEmail }))
      vi.stubGlobal('useAuthProvider', () => ({ getUserById: vi.fn().mockResolvedValue({ email: 'owner@example.com' }) }))
      vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
        upsertPaymentAccount,
        archiveActivePaymentAccount,
        updateWorkspace,
        getActivePaymentAccount,
        markWorkspaceTrialConsumed,
        setPaymentAccountMetadataKey,
        getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', name: 'Acme', slug: 'acme', owner_id: 'user-1', plan: 'pro' }),
      }))
    }
    const subjects = () => sendEmail.mock.calls.map(([mail]) => (mail as { subject: string }).subject)

    const activeAccount = {
      provider: 'polar',
      customer_id: 'cus_123',
      subscription_id: 'sub_123',
      subscription_status: 'active',
      current_period_end: '2026-10-23T11:50:43.823Z',
      trial_ends_at: null,
      grace_period_ends_at: null,
      cancel_at_period_end: false,
      plan: 'pro',
    }
    const update = (overrides: Record<string, unknown>) => ({
      event: 'subscription.updated',
      workspaceId: 'ws-1',
      plan: 'pro',
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
      subscriptionStatus: 'active',
      currentPeriodStart: '2026-09-23T11:50:43.823Z',
      currentPeriodEnd: '2026-10-23T11:50:43.823Z',
      cancelAtPeriodEnd: false,
      ...overrides,
    })

    describe('activation email: on the first paid order, not the status change (ST-10 b)', () => {
      const ACTIVATED = 'Your Pro plan is active on Contentrain Studio'
      const RECOVERED_PREFIX = 'Payment received'
      const trialingAccount = { ...activeAccount, subscription_status: 'trialing', trial_ends_at: '2026-09-29T07:36:51.653Z', plugin_metadata: {} }
      const paidOrder = (amountPaid: number) => ({ event: 'invoice.paid', workspaceId: 'ws-1', customerId: 'cus_123', subscriptionId: 'sub_123', invoiceId: 'ord_1', amountPaid })

      /**
       * One payment_accounts row with the provider's write semantics: an
       * upsert replaces the columns it is given and keeps
       * `preserveMetadataKeys` from the row at write time; the metadata-key
       * write is a compare-and-set. `readBarrier(n)` holds every read until
       * n reads have happened — each event then works from the same
       * snapshot, the interleaving that loses a write if the route writes
       * back what it read.
       */
      function accountStore(initial: Record<string, unknown>) {
        let row: Record<string, unknown> = structuredClone(initial)
        let barrier: { waiting: number, release: () => void, done: Promise<void> } | null = null
        const store = {
          row: () => row,
          readBarrier(n: number) {
            let release!: () => void
            const done = new Promise<void>((resolve) => {
              release = resolve
            })
            barrier = { waiting: n, release, done }
          },
          getActivePaymentAccount: vi.fn(async () => {
            const snapshot = structuredClone(row)
            if (barrier) {
              const b = barrier
              if (--b.waiting === 0) {
                barrier = null
                b.release()
              }
              await b.done
            }
            return snapshot
          }),
          upsertPaymentAccount: vi.fn(async (input: Record<string, unknown>) => {
            const stored = (row.plugin_metadata ?? {}) as Record<string, unknown>
            let metadata = stored
            if (input.pluginMetadata !== undefined) {
              metadata = { ...(input.pluginMetadata as Record<string, unknown>) }
              for (const key of (input.preserveMetadataKeys as string[] | undefined) ?? []) {
                if (key in stored) metadata[key] = stored[key]
                else Reflect.deleteProperty(metadata, key)
              }
            }
            row = {
              ...row,
              subscription_status: input.subscriptionStatus ?? null,
              trial_ends_at: input.trialEndsAt ?? null,
              grace_period_ends_at: input.gracePeriodEndsAt ?? null,
              plugin_metadata: metadata,
            }
            return row
          }),
          setPaymentAccountMetadataKey: vi.fn(async ({ key, value, when }: { key: string, value: string, when: 'absent' | 'different' | { equals: string } }) => {
            const metadata = (row.plugin_metadata ?? {}) as Record<string, unknown>
            const allowed = when === 'absent'
              ? !(key in metadata)
              : when === 'different' ? metadata[key] !== value : metadata[key] === when.equals
            if (!allowed) return false
            row = { ...row, plugin_metadata: { ...metadata, [key]: value } }
            return true
          }),
        }
        return store
      }

      function useStore(store: ReturnType<typeof accountStore>) {
        captureEmails()
        vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
          upsertPaymentAccount: store.upsertPaymentAccount,
          getActivePaymentAccount: store.getActivePaymentAccount,
          setPaymentAccountMetadataKey: store.setPaymentAccountMetadataKey,
          archiveActivePaymentAccount,
          updateWorkspace,
          markWorkspaceTrialConsumed,
          getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', name: 'Acme', slug: 'acme', owner_id: 'user-1', plan: 'pro' }),
        }))
      }

      async function deliver(...events: Record<string, unknown>[]) {
        const handler = await mockPluginAndLoadHandler()
        for (const e of events) handleWebhookMock.mockResolvedValueOnce(e)
        await Promise.all(events.map(() => handler({ context: {} } as never)))
      }

      const meta = (store: ReturnType<typeof accountStore>) => store.row().plugin_metadata as Record<string, unknown>

      it('trial → active sends nothing yet and marks the email owed', async () => {
        const store = accountStore(trialingAccount)
        useStore(store)

        await deliver(update({}))

        expect(subjects()).not.toContain(ACTIVATED)
        expect(store.row().subscription_status).toBe('active')
        expect(meta(store).activation_email).toBe('pending')
      })

      it('the first paid order sends it once, records it, and writes nothing else', async () => {
        const store = accountStore({ ...activeAccount, plugin_metadata: { activation_email: 'pending' } })
        useStore(store)

        await deliver(paidOrder(4900))
        await deliver(paidOrder(4900))

        expect(subjects()).toEqual([ACTIVATED])
        expect(meta(store).activation_email).toBe('sent')
      })

      it('a trial whose charge fails never says activated', async () => {
        const store = accountStore(trialingAccount)
        useStore(store)

        await deliver(update({}))
        await deliver(update({ subscriptionStatus: 'past_due' }))

        expect(subjects()).not.toContain(ACTIVATED)
      })

      it('an order paid before the status update still sends it — once — and leaves the status to the update', async () => {
        const store = accountStore(trialingAccount)
        useStore(store)

        await deliver(paidOrder(4900))
        expect(subjects()).toEqual([ACTIVATED])
        expect(store.row().subscription_status).toBe('trialing')

        await deliver(update({}))

        expect(subjects()).toEqual([ACTIVATED])
        expect(store.row().subscription_status).toBe('active')
        expect(meta(store).activation_email).toBe('sent')
      })

      it('a trial\'s $0 invoice sends nothing', async () => {
        const store = accountStore(trialingAccount)
        useStore(store)

        await deliver(paidOrder(0))

        expect(sendEmail).not.toHaveBeenCalled()
        expect(store.upsertPaymentAccount).not.toHaveBeenCalled()
        expect(meta(store)).toEqual({})
      })

      // QA-7: at conversion the provider sends the update and the order
      // together. Both read the trialing row before either writes.
      for (const order of [['update', 'order'], ['order', 'update']] as const) {
        it(`update and order at once (${order.join(' first, ')} after the reads): one email, account active, marker kept`, async () => {
          const store = accountStore(trialingAccount)
          useStore(store)
          const events = { update: update({}), order: paidOrder(4900) }

          store.readBarrier(2)
          await deliver(...order.map(k => events[k]))

          expect(subjects()).toEqual([ACTIVATED])
          expect(store.row().subscription_status).toBe('active')
          expect(meta(store).activation_email).toBe('sent')

          // Next month's renewal does not say "activated" again.
          await deliver(paidOrder(4900))
          expect(subjects()).toEqual([ACTIVATED])
        })
      }

      it('a trial\'s failed first charge that then goes through says "activated", not "payment received"', async () => {
        const store = accountStore(trialingAccount)
        useStore(store)

        await deliver(update({ subscriptionStatus: 'past_due' }))
        expect(meta(store).activation_email).toBe('pending')

        store.readBarrier(2)
        await deliver(update({}), paidOrder(4900))

        expect(subjects().filter(s => s === ACTIVATED)).toHaveLength(1)
        expect(subjects().some(s => s.startsWith(RECOVERED_PREFIX))).toBe(false)
        expect(store.row().subscription_status).toBe('active')
      })

      it('an ordinary renewal that recovers from past_due still says "payment received"', async () => {
        const store = accountStore({ ...activeAccount, subscription_status: 'past_due', grace_period_ends_at: '2026-09-30T12:00:00.000Z', plugin_metadata: { activation_email: 'sent' } })
        useStore(store)

        await deliver(paidOrder(4900))

        expect(subjects()).not.toContain(ACTIVATED)
        expect(subjects().some(s => s.startsWith(RECOVERED_PREFIX))).toBe(true)
      })

      it('an ordinary recovery whose update and order arrive together says "payment received" once — and again for the next problem', async () => {
        const pastDue = { ...activeAccount, subscription_status: 'past_due', grace_period_ends_at: '2026-09-30T12:00:00.000Z', plugin_metadata: { activation_email: 'sent' } }
        const store = accountStore(pastDue)
        useStore(store)

        store.readBarrier(2)
        await deliver(update({}), paidOrder(4900))

        expect(subjects().filter(s => s.startsWith(RECOVERED_PREFIX))).toHaveLength(1)
        expect(store.row().subscription_status).toBe('active')

        // A later renewal fails and recovers: a new episode, a new email.
        await deliver(update({ subscriptionStatus: 'past_due' }))
        const nextGrace = store.row().grace_period_ends_at
        expect(nextGrace).not.toBe(pastDue.grace_period_ends_at)
        await deliver(paidOrder(4900))
        expect(subjects().filter(s => s.startsWith(RECOVERED_PREFIX))).toHaveLength(2)
      })

      it('a conversion order discounted to $0 that beats the update still says activated — the trial\'s own $0 order does not', async () => {
        const store = accountStore(trialingAccount)
        useStore(store)

        await deliver({ ...paidOrder(0), billingReason: 'subscription_create' })
        expect(subjects()).toEqual([])

        await deliver({ ...paidOrder(0), billingReason: 'subscription_cycle' })
        await deliver(update({}))

        expect(subjects()).toEqual([ACTIVATED])
        expect(meta(store).activation_email).toBe('sent')
      })
    })

    it('keeps the plan until the period end when a cancellation is scheduled, and says until when', async () => {
      captureEmails()
      getActivePaymentAccount.mockResolvedValue(activeAccount)
      handleWebhookMock.mockResolvedValue(update({ cancelAtPeriodEnd: true, accessEndsAt: '2026-10-23T11:50:43.823Z' }))

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(archiveActivePaymentAccount).not.toHaveBeenCalled()
      expect(updateWorkspace).not.toHaveBeenCalledWith('', 'ws-1', expect.objectContaining({ plan: 'free' }))
      expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionStatus: 'active',
        cancelAtPeriodEnd: true,
        isActive: true,
        plan: 'pro',
      }))
      expect(subjects()).toEqual(['Your Pro plan stays active until Friday, October 23'])
    })

    it('does not repeat the cancel notice when the same cancellation arrives again', async () => {
      captureEmails()
      getActivePaymentAccount.mockResolvedValue({ ...activeAccount, cancel_at_period_end: true })
      handleWebhookMock.mockResolvedValue(update({ cancelAtPeriodEnd: true, accessEndsAt: '2026-10-23T11:50:43.823Z' }))

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('opens a 7-day grace window and tells the owner when a renewal fails', async () => {
      captureEmails()
      getActivePaymentAccount.mockResolvedValue(activeAccount)
      handleWebhookMock.mockResolvedValue(update({ subscriptionStatus: 'past_due' }))

      const handler = await mockPluginAndLoadHandler()
      const before = Date.now()
      await handler({ context: {} } as never)

      const written = upsertPaymentAccount.mock.calls[0]![0] as { subscriptionStatus: string, gracePeriodEndsAt: string }
      expect(written.subscriptionStatus).toBe('past_due')
      const graceMs = new Date(written.gracePeriodEndsAt).getTime() - before
      expect(graceMs).toBeGreaterThanOrEqual(7 * 24 * 3600 * 1000 - 5000)
      expect(graceMs).toBeLessThanOrEqual(7 * 24 * 3600 * 1000 + 5000)
      expect(subjects()).toEqual(['Action required: payment failed for Acme'])
    })

    it('keeps the running grace window on a retry and does not email again', async () => {
      captureEmails()
      getActivePaymentAccount.mockResolvedValue({ ...activeAccount, subscription_status: 'past_due', grace_period_ends_at: '2026-09-30T12:00:00.000Z' })
      handleWebhookMock.mockResolvedValue(update({ subscriptionStatus: 'past_due' }))

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionStatus: 'past_due',
        gracePeriodEndsAt: '2026-09-30T12:00:00.000Z',
      }))
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('closes the grace window and says so when the charge goes through', async () => {
      captureEmails()
      getActivePaymentAccount.mockResolvedValue({ ...activeAccount, subscription_status: 'past_due', grace_period_ends_at: '2026-09-30T12:00:00.000Z' })
      handleWebhookMock.mockResolvedValue(update({ subscriptionStatus: 'active' }))

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(upsertPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionStatus: 'active',
        gracePeriodEndsAt: null,
      }))
      expect(subjects()).toEqual(['Payment received — Acme is active again'])
    })

    it('tells the owner once when a subscription ends, however many ending events arrive', async () => {
      captureEmails()
      const ended = { event: 'subscription.canceled', workspaceId: 'ws-1', subscriptionId: 'sub_123', customerId: 'cus_123', subscriptionStatus: 'canceled' }
      handleWebhookMock.mockResolvedValue(ended)
      const handler = await mockPluginAndLoadHandler()

      getActivePaymentAccount.mockResolvedValueOnce(activeAccount)
      await handler({ context: {} } as never)
      // canceled + revoked follow; the account is already archived.
      getActivePaymentAccount.mockResolvedValue(null)
      await handler({ context: {} } as never)
      await handler({ context: {} } as never)

      expect(subjects()).toEqual(['Your Contentrain Studio subscription has been canceled'])
    })

    it('leaves a newer subscription alone when a late update for the old one arrives', async () => {
      captureEmails()
      getActivePaymentAccount.mockResolvedValue({ ...activeAccount, subscription_id: 'sub_new' })
      // The old subscription's past_due, delivered after the workspace moved on.
      handleWebhookMock.mockResolvedValue(update({ subscriptionId: 'sub_123', subscriptionStatus: 'past_due' }))

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(upsertPaymentAccount).not.toHaveBeenCalled()
      expect(updateWorkspace).not.toHaveBeenCalled()
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it('leaves a newer subscription alone when a late ending event for the old one arrives', async () => {
      captureEmails()
      getActivePaymentAccount.mockResolvedValue({ ...activeAccount, subscription_id: 'sub_new' })
      handleWebhookMock.mockResolvedValue({ event: 'subscription.canceled', workspaceId: 'ws-1', subscriptionId: 'sub_123', customerId: 'cus_123', subscriptionStatus: 'canceled' })

      const handler = await mockPluginAndLoadHandler()
      await handler({ context: {} } as never)

      expect(archiveActivePaymentAccount).not.toHaveBeenCalled()
      expect(updateWorkspace).not.toHaveBeenCalled()
      expect(sendEmail).not.toHaveBeenCalled()
    })
  })
})
