import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the outbox row that never dies.
 *
 * The give-up branch used to call `markUsageEventIngested(id, reason)`,
 * but that overload records a *retryable* attempt: it bumps
 * `attempt_count` and deliberately leaves `ingested_at` null. So the row
 * stayed pending, and since `listPendingUsageEvents` orders oldest-first
 * with a fixed batch size, a handful of them permanently occupied the
 * head of every batch. Observed on staging: 52 rows, one at 271,814
 * attempts, retried every 30s since June. Once such rows fill a batch,
 * no new meter event ever reaches the payment provider again and overage
 * billing silently stops — with the drain reporting success throughout.
 */

const { listPending, markIngested, markDropped, getAccount, ingest } = vi.hoisted(() => ({
  listPending: vi.fn(),
  markIngested: vi.fn(),
  markDropped: vi.fn(),
  getAccount: vi.fn(),
  ingest: vi.fn(),
}))

vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: () => ({
    listPendingUsageEvents: listPending,
    markUsageEventIngested: markIngested,
    markUsageEventDropped: markDropped,
    getActivePaymentAccount: getAccount,
  }),
  usePaymentProvider: () => ({ ingestUsageEvent: ingest }),
}))

// The module registers a Nitro plugin at import time; the auto-import is
// not present under vitest, so stub it before loading.
vi.stubGlobal('defineNitroPlugin', () => {})

const { drainUsageOutbox } = await import('../../server/plugins/usage-drain')

const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  workspace_id: 'ws-1',
  meter_name: 'ai_messages',
  value: 3,
  idempotency_key: 'ai:ws-1:u1:2026-09:1',
  occurred_at: '2026-09-21T10:00:00.000Z',
  attempt_count: 0,
  last_error: null,
  ...over,
})

describe('usage outbox drain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getAccount.mockResolvedValue({ customer_id: 'cus_1' })
  })

  it('retires an exhausted row instead of recording another attempt', async () => {
    listPending.mockResolvedValue([row({ attempt_count: 999, last_error: 'boom' })])

    await drainUsageOutbox()

    // The give-up path must set `ingested_at` — which only the drop call does.
    expect(markDropped).toHaveBeenCalledTimes(1)
    expect(markDropped.mock.calls[0]![0]).toBe('row-1')
    expect(markIngested).not.toHaveBeenCalled()
    // And it must never be handed to the provider again.
    expect(ingest).not.toHaveBeenCalled()
  })

  it('keeps retrying a row whose workspace has no payment account yet', async () => {
    // Checkout has completed but `subscription.created` has not landed, so
    // there is nothing to ingest against. The row must stay pending.
    getAccount.mockResolvedValue(null)
    listPending.mockResolvedValue([row()])

    await drainUsageOutbox()

    expect(markDropped).not.toHaveBeenCalled()
    expect(markIngested).toHaveBeenCalledWith('row-1', 'No active payment account')
  })

  it('allows more than eight attempts before giving up', async () => {
    // The old threshold was 8 ticks — four minutes — which is inside the
    // window a checkout webhook can still be in flight.
    getAccount.mockResolvedValue(null)
    listPending.mockResolvedValue([row({ attempt_count: 8 })])

    await drainUsageOutbox()

    expect(markDropped).not.toHaveBeenCalled()
  })

  it('marks a delivered row ingested', async () => {
    listPending.mockResolvedValue([row()])

    await drainUsageOutbox()

    expect(ingest).toHaveBeenCalledTimes(1)
    expect(ingest.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1',
      customerId: 'cus_1',
      meterName: 'ai_messages',
      value: 3,
      idempotencyKey: 'ai:ws-1:u1:2026-09:1',
    })
    expect(markIngested).toHaveBeenCalledWith('row-1', null)
    expect(markDropped).not.toHaveBeenCalled()
  })

  it('records a retryable attempt when the provider rejects the event', async () => {
    listPending.mockResolvedValue([row()])
    ingest.mockRejectedValue(new Error('polar down'))

    await drainUsageOutbox()

    expect(markIngested).toHaveBeenCalledWith('row-1', 'polar down')
    expect(markDropped).not.toHaveBeenCalled()
  })
})
