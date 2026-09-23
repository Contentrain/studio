import { defineEventHandler } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'
import { CHAT_PATH, createCreditPool, loadChatHandler, stubChatRoute, waitFor } from '../helpers/chat-credit-pool'

/**
 * MG-12 D2 — a turn cut because the workspace's monthly credits ran out
 * must say so, and hand the client the same notice a refused next message
 * gets (ST-5: credits, reset date, link to Usage). "Send a new message to
 * continue" would be wrong advice: the next message is a 429.
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

/** A model that wants 12K output tokens and honours `max_tokens` like the API. */
async function* wantsLongAnswer(request: { maxTokens: number }): AsyncGenerator<Record<string, unknown>> {
  const output = Math.min(12_000, request.maxTokens)
  yield { type: 'text', content: 'Rewriting…' }
  yield {
    type: 'message_end',
    stopReason: output < 12_000 ? 'max_tokens' : 'end_turn',
    usage: { inputTokens: 5_000, outputTokens: output, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  }
}

async function doneEvent(pool: ReturnType<typeof createCreditPool>): Promise<Record<string, unknown>> {
  let done: Record<string, unknown> = {}
  const billing = defineEventHandler((event) => {
    event.context.billing = { overageSettings: { ai_messages: false } }
  })
  await withTestServer({ middleware: [billing], routes: [{ path: CHAT_PATH, handler: await loadChatHandler() }] }, async ({ request }) => {
    const response = await request(CHAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'rewrite the post', conversationId: 'conversation-existing' }),
    })
    const body = await response.text()
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue
      const evt = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
      if (evt.type === 'done') done = evt
    }
    await waitFor(() => pool.state.settles.length >= 1)
  })
  return done
}

describe('chat route — a turn cut by the month\'s last credits (MG-12 D2)', () => {
  it('carries the credits-exhausted notice on done, and says so in the text', async () => {
    // Starter, 1 credit left: the budget is $0.03, far below the turn cap.
    const pool = createCreditPool(59)
    stubChatRoute(pool, { plan: 'starter', limit: 60, stream: wantsLongAnswer })
    vi.stubGlobal('errorMessage', vi.fn((key: string) => `msg:${key}`))

    const done = await doneEvent(pool)

    expect(done.stoppedBy).toBe('credits')
    expect(done.code).toBe('ai_credits_exhausted')
    expect(done.message).toBe('msg:chat.monthly_limit_reached')
    expect(typeof done.resetsAt).toBe('string')
  })

  it('a turn cut by the per-message cap does not claim the month is used up', async () => {
    // Plenty left in the pool: the ceiling is the plan's per-message cap.
    const pool = createCreditPool(0)
    stubChatRoute(pool, { plan: 'starter', limit: 60, stream: wantsLongAnswer })

    const done = await doneEvent(pool)

    expect(done.code).toBeUndefined()
    expect(done.stoppedBy).not.toBe('credits')
  })
})
