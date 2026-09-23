import { beforeEach, describe, expect, it, vi } from 'vitest'

const enqueueUsageEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../server/utils/license', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/license')>()),
  isBillingConfigured: () => true,
}))

/**
 * A credit is sent to the meter its subscription is priced on: a pre-v2
 * subscription's $0.03 credits to `ai_credits`, a v2 one's $0.01 credits to
 * `ai_credits_1c`. Sending either to the other's meter would bill 3× too much
 * or too little.
 */
describe('usage metering — credit meters by unit', () => {
  beforeEach(() => {
    enqueueUsageEvent.mockClear()
    vi.stubGlobal('useDatabaseProvider', () => ({ enqueueUsageEvent }))
  })

  it('sends AI and API credits to the meter of the account\'s unit', async () => {
    const { recordAIUsage, recordAPIUsage } = await import('../../server/utils/usage-metering')
    await recordAIUsage({ workspaceId: 'ws', count: 7, userId: 'u', month: '2026-09-15', creditUnit: '0.03' })
    await recordAIUsage({ workspaceId: 'ws', count: 21, userId: 'u', month: '2026-09-15', creditUnit: '0.01' })
    await recordAPIUsage({ workspaceId: 'ws', count: 3, apiKeyId: 'k', month: '2026-09-15', creditUnit: '0.03' })
    await recordAPIUsage({ workspaceId: 'ws', count: 9, apiKeyId: 'k', month: '2026-09-15', creditUnit: '0.01' })
    expect(enqueueUsageEvent.mock.calls.map(([e]) => [e.meterName, e.value])).toEqual([
      ['ai_credits', 7],
      ['ai_credits_1c', 21],
      ['api_credits', 3],
      ['api_credits_1c', 9],
    ])
  })
})
