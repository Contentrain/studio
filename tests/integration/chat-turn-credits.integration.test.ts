import { describe, expect, it, vi } from 'vitest'
import { defineEventHandler } from 'h3'
import { withTestServer } from '../helpers/http'
import { CHAT_PATH, createCreditPool, loadChatHandler, stubChatRoute, waitFor } from '../helpers/chat-credit-pool'

/**
 * The figures in this file are $0.03 credits: the billing middleware's
 * context for a pre-v2 account (`credit-unit.ts`).
 */
const legacyAccount = defineEventHandler((event) => {
  event.context.billing = { overageSettings: {}, creditUnit: '0.03' }
})

/**
 * AI-8 — the chat route's credit accounting under concurrency, client
 * disconnect and mid-stream failure.
 *
 * The database is the in-memory pool from `tests/helpers/chat-credit-pool`,
 * which implements BOTH reservation RPCs with the same atomic semantics
 * as the SQL (027/030 reserve 1; 031 reserves up to the turn ceiling),
 * and a settle that applies the delta. The same assertions therefore run against the old flow
 * (reserve 1, settle `credits - 1` at the end of a completed turn) and
 * the new one (reserve the ceiling, settle in `finally`), and only the
 * new one keeps the pool within its limit and counts what a cancelled
 * turn really cost.
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

describe('chat route — turn credits (AI-8)', () => {
  it('two concurrent heavy turns cannot push the pool past its limit', async () => {
    // Pro, limit 100, 20 already used. Each turn really costs 45 credits:
    // 1M input + 70K output on Haiku 4.5 = $1.35. Both turns reserve
    // before either settles (the barrier holds both streams).
    const pool = createCreditPool(20)
    let started = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    stubChatRoute(pool, {
      plan: 'pro',
      limit: 100,
      stream: async function* () {
        started++
        if (started === 2) release()
        await barrier
        yield { type: 'text', content: 'Done.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1_000_000, outputTokens: 70_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }
      },
    })

    await withTestServer({ middleware: [legacyAccount], routes: [{ path: CHAT_PATH, handler: await loadChatHandler() }] }, async ({ request }) => {
      const send = () => request(CHAT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'rewrite every entry', conversationId: 'conversation-existing' }),
      }).then(r => r.text())
      await Promise.all([send(), send()])
      await waitFor(() => pool.state.settles.length >= 2)
    })

    // Old flow: 20 + 1 + 1 reserved, then +44 +44 settled = 110.
    expect(pool.state.studioTotal).toBeLessThanOrEqual(100)
    // The first turn is counted in full; the second only up to what was left.
    expect(pool.state.studioTotal).toBe(20 + 45 + 20)
  })

  it('a turn the client cancels mid-stream counts what it really cost', async () => {
    // Starter, Haiku. The call's prompt is 300K tokens ($0.30 = 10
    // credits) and is billed by Anthropic as soon as the call starts; the
    // client disconnects while the answer is streaming.
    const pool = createCreditPool(0)
    let sawAbort = false
    const { meter } = stubChatRoute(pool, {
      plan: 'starter',
      limit: 60,
      stream: async function* (req) {
        yield { type: 'message_start', usage: { inputTokens: 300_000, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }
        yield { type: 'text', content: 'Rewriting the first entry now' }
        await new Promise<void>((_, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          req.abortSignal?.addEventListener('abort', () => {
            sawAbort = true
            fail()
          })
          setTimeout(fail, 3000)
        })
      },
    })

    await withTestServer({ middleware: [legacyAccount], routes: [{ path: CHAT_PATH, handler: await loadChatHandler() }] }, async ({ request }) => {
      const controller = new AbortController()
      const response = await request(CHAT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello', conversationId: 'conversation-existing' }),
        signal: controller.signal,
      })
      const reader = response.body!.getReader()
      let seen = ''
      while (!seen.includes('"type":"text"')) {
        const { value, done } = await reader.read()
        if (done) break
        seen += new TextDecoder().decode(value)
      }
      controller.abort()
      await waitFor(() => pool.state.settles.length >= 1)
    })

    expect(sawAbort).toBe(true)
    // Old flow: the reserved 1 stays, nothing else — the turn cost 10.
    expect(pool.state.studioTotal).toBe(10)
    expect(meter).toEqual([10])
  })

  it('a turn that fails mid-stream counts what it really cost', async () => {
    const pool = createCreditPool(0)
    const { meter } = stubChatRoute(pool, {
      plan: 'starter',
      limit: 60,
      stream: async function* () {
        yield { type: 'message_start', usage: { inputTokens: 300_000, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }
        yield { type: 'text', content: 'Rewriting the first entry now' }
        throw new Error('overloaded_error')
      },
    })

    await withTestServer({ middleware: [legacyAccount], routes: [{ path: CHAT_PATH, handler: await loadChatHandler() }] }, async ({ request }) => {
      const response = await request(CHAT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello', conversationId: 'conversation-existing' }),
      })
      expect(await response.text()).toContain('overloaded_error')
      await waitFor(() => pool.state.settles.length >= 1)
    })

    expect(pool.state.studioTotal).toBe(10)
    expect(meter).toEqual([10])
  })
})
