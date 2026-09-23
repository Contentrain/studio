import { defineEventHandler } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'
import { CHAT_PATH, createCreditPool, heavyTurn, loadChatHandler, stubChatRoute, waitFor } from '../helpers/chat-credit-pool'

/**
 * BR-11 P0-1 — with overage OFF, AI usage past the plan's included
 * credits must never reach the payment meter. The customer sees a hard
 * limit; a meter event past it is an overage invoice they never enabled.
 * With overage ON the turn is metered in full.
 */

vi.mock('~~/server/utils/agent-types', async () => await import('../../server/utils/agent-types'))
vi.mock('~~/server/utils/agent-state-machine', async () => await import('../../server/utils/agent-state-machine'))
vi.mock('~~/server/utils/agent-context', async () => await import('../../server/utils/agent-context'))
vi.mock('~~/server/utils/agent-system-prompt', async () => await import('../../server/utils/agent-system-prompt'))
vi.mock('~~/server/utils/conversation-engine', async () => await import('../../server/utils/conversation-engine'))
vi.mock('~~/server/utils/conversation-history', async () => await import('../../server/utils/conversation-history'))
vi.mock('../../server/utils/enterprise', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/utils/enterprise')>()),
  resolveEnterpriseChatApiKey: async () => ({ apiKey: 'sk-studio', usageSource: 'studio' }),
}))

async function sendTurn(pool: ReturnType<typeof createCreditPool>, opts: { overage?: boolean, creditUnit?: '0.03' | '0.01' } = {}): Promise<number> {
  let status = 0
  // The billing middleware's context, as `03.billing.ts` sets it: the
  // route reads the workspace's overage toggles from here.
  const billing = defineEventHandler((event) => {
    // These cases are a pre-v2 ($0.03-credit) Pro account unless a test says otherwise.
    event.context.billing = { overageSettings: { ai_messages: opts.overage === true }, creditUnit: opts.creditUnit ?? '0.03' }
  })
  await withTestServer({ middleware: [billing], routes: [{ path: CHAT_PATH, handler: await loadChatHandler() }] }, async ({ request }) => {
    const response = await request(CHAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'rewrite every entry', conversationId: 'conversation-existing' }),
    })
    status = response.status
    await response.text()
    if (status === 200) await waitFor(() => pool.state.settles.length >= 1)
  })
  return status
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

describe('chat route — the payment meter respects overage off (BR-11 P0-1)', () => {
  it('overage off, included credits used up: the turn is refused and nothing is metered', async () => {
    const pool = createCreditPool(350)
    const { meter } = stubChatRoute(pool, { plan: 'pro', limit: 350, stream: heavyTurn })

    expect(await sendTurn(pool)).toBe(429)
    expect(meter).toEqual([])
  })

  it('overage off, one included credit left: a 45-credit turn meters exactly that one', async () => {
    const pool = createCreditPool(349)
    const { meter } = stubChatRoute(pool, { plan: 'pro', limit: 350, stream: heavyTurn })

    expect(await sendTurn(pool)).toBe(200)
    // Before the fix: 1 on the first event + 44 at the settle = 45, all
    // billed as overage the workspace had switched off.
    expect(sum(meter)).toBe(1)
  })

  it('overage on, past the included credits: the turn is metered in full', async () => {
    const pool = createCreditPool(400)
    const { meter } = stubChatRoute(pool, { plan: 'pro', limit: 350, stream: heavyTurn })

    expect(await sendTurn(pool, { overage: true })).toBe(200)
    expect(sum(meter)).toBe(45)
  })

  it('a v2 account meters the same turn in $0.01 credits on its own meter; a pre-v2 one in $0.03 credits on its own', async () => {
    const v2 = createCreditPool(2000)
    const current = stubChatRoute(v2, { plan: 'pro', limit: 1600, stream: heavyTurn })
    expect(await sendTurn(v2, { overage: true, creditUnit: '0.01' })).toBe(200)
    const v2Credits = sum(current.meter)
    expect(current.meterUnits.every(u => u === '0.01')).toBe(true)

    const legacyPool = createCreditPool(400)
    const legacy = stubChatRoute(legacyPool, { plan: 'pro', limit: 350, stream: heavyTurn })
    expect(await sendTurn(legacyPool, { overage: true })).toBe(200)
    expect(sum(legacy.meter)).toBe(45)
    expect(legacy.meterUnits.every(u => u === '0.03')).toBe(true)

    // Same dollars, three times the credits — never the legacy count read as $0.01.
    expect(v2Credits).toBeGreaterThanOrEqual(45 * 3 - 3)
    expect(v2Credits).toBeLessThanOrEqual(45 * 3 + 3)
  })
})
