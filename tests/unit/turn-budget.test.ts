import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIMessage, AIProvider } from '../../server/providers/ai'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext, ProjectPhase } from '../../server/utils/agent-types'
import { estimateMessageCostUsd, pricingForModel, settleTurnCredits } from '../../shared/utils/ai-credits'
import { THINKING_HEADROOM_TOKENS, TurnUsageTracker, nextPromptEstimate, outputFloorsFor, planCall, promptCostUsd } from '../../server/utils/turn-budget'

// The loop tests import the whole conversation engine; its first import
// takes several seconds when the suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })

/**
 * AI-8 — the per-turn spend budget. Pure planner and tracker first, then
 * the conversation loop: an expensive tool-looping turn must stop inside
 * its budget with a proper closing message, and a normal turn must run
 * exactly as it did without one.
 */

const HAIKU = 'claude-haiku-4-5-20251001'
const OPUS = 'claude-opus-5-5'
const ZERO = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }

describe('planCall', () => {
  it('gives the full output allowance when the budget covers the worst case', () => {
    const plan = planCall({ budget: { maxUsd: 0.9 }, spentUsd: 0, model: HAIKU, prompt: { cached: 0, fresh: 20_000 }, maxOutputTokens: 16_000, minOutputTokens: 1024 })
    expect(plan).toEqual({ ok: true, maxTokens: 16_000, limited: false })
  })

  it('lowers max_tokens to what the remaining budget can pay for', () => {
    // $0.90 − $0.80 spent − 20K fresh × $1 × 2 ($0.04) = $0.06 → 12,000 tokens at $5/MTok.
    const plan = planCall({ budget: { maxUsd: 0.9 }, spentUsd: 0.8, model: HAIKU, prompt: { cached: 0, fresh: 20_000 }, maxOutputTokens: 16_000, minOutputTokens: 1024 })
    expect(plan.ok && plan.limited).toBe(true)
    expect(plan.ok && plan.maxTokens).toBeGreaterThanOrEqual(11_999)
    expect(plan.ok && plan.maxTokens).toBeLessThanOrEqual(12_000)
  })

  it('keeps a reserve back for a later call', () => {
    const plan = planCall({ budget: { maxUsd: 0.9 }, spentUsd: 0.8, reserveUsd: 0.05, model: HAIKU, prompt: { cached: 0, fresh: 20_000 }, maxOutputTokens: 16_000, minOutputTokens: 1024 })
    expect(plan.ok && plan.maxTokens).toBeLessThanOrEqual(2000)
  })

  it('refuses a call once not even the minimum output fits', () => {
    const plan = planCall({ budget: { maxUsd: 0.9 }, spentUsd: 0.88, model: HAIKU, prompt: { cached: 0, fresh: 20_000 }, maxOutputTokens: 16_000, minOutputTokens: 1024 })
    expect(plan).toEqual({ ok: false })
  })

  it('prices cached prompt at the cache-read rate and new prompt at the cache-write rate', () => {
    const next = nextPromptEstimate({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 4000, cacheReadInputTokens: 30_000 }, 2000)
    expect(next).toEqual({ cached: 34_000, fresh: 3500 })
  })
})

describe('thinking models under the budget (QA-4 F1)', () => {
  it('gives thinking models headroom on every floor, others the plain floors', () => {
    expect(outputFloorsFor(HAIKU)).toEqual({ minToolCall: 1024, close: 1024, minClose: 256 })
    expect(outputFloorsFor(OPUS)).toEqual({
      minToolCall: 1024 + THINKING_HEADROOM_TOKENS,
      close: 1024 + THINKING_HEADROOM_TOKENS,
      minClose: 256 + THINKING_HEADROOM_TOKENS,
    })
  })

  it('prices cached prompt at the model\'s own cache-read rate (Opus 5.5: 0.05x)', () => {
    // 1M cached on Opus 5.5 = $4 × 0.05 = $0.20, not the flat 0.1x $0.40.
    expect(promptCostUsd({ cached: 1_000_000, fresh: 0 }, pricingForModel(OPUS))).toBeCloseTo(0.2, 6)
  })
})

describe('TurnUsageTracker', () => {
  it('counts a call in flight: its prompt at once, its output as it streams', () => {
    const tracker = new TurnUsageTracker()
    tracker.endCall({ inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })
    tracker.startCall({ inputTokens: 300_000, outputTokens: 1, cacheCreationInputTokens: 10, cacheReadInputTokens: 20 })
    tracker.addStreamedOutput('x'.repeat(350))

    expect(tracker.snapshot()).toEqual({ inputTokens: 300_100, outputTokens: 150, cacheCreationInputTokens: 10, cacheReadInputTokens: 20 })
    expect(tracker.confirmed).toEqual({ inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })
  })

  it('replaces the estimate with the real figures when the call ends', () => {
    const tracker = new TurnUsageTracker()
    tracker.startCall({ inputTokens: 1000, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })
    tracker.addStreamedOutput('x'.repeat(3500))
    tracker.endCall({ inputTokens: 1000, outputTokens: 800, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })
    expect(tracker.snapshot()).toEqual({ inputTokens: 1000, outputTokens: 800, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })
  })
})

describe('settleTurnCredits', () => {
  it('is 0 for a turn that never reached the model, so the reservation is refunded', () => {
    expect(settleTurnCredits({ model: HAIKU, ...ZERO }, 30, '0.03')).toBe(0)
  })

  it('is at least 1 once any token was spent, and never more than was reserved', () => {
    expect(settleTurnCredits({ model: HAIKU, ...ZERO, inputTokens: 10 }, 30, '0.03')).toBe(1)
    expect(settleTurnCredits({ model: HAIKU, ...ZERO, inputTokens: 300_000 }, 30, '0.03')).toBe(10)
    expect(settleTurnCredits({ model: HAIKU, ...ZERO, inputTokens: 3_000_000 }, 30, '0.03')).toBe(30)
  })
})

// ─── The loop ───

function stubLoopGlobals(aiProvider: Partial<AIProvider>) {
  vi.stubGlobal('emptyAffected', vi.fn(() => ({ models: [], locales: [], snapshotChanged: false, branchesChanged: false })))
  vi.stubGlobal('mergeAffected', vi.fn(a => a))
  // Every tool call is refused by the state guard: the loop keeps going
  // with an error result and no tool actually runs.
  vi.stubGlobal('checkStateTransition', vi.fn().mockReturnValue({ allowed: false, reason: 'blocked by test', suggestion: 'continue' }))
  vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue(aiProvider))
}

function toolContext() {
  return {
    engine: {} as never,
    git: {} as never,
    userEmail: 'user@example.com',
    userId: 'user-1',
    contentRoot: 'content',
    workflow: 'auto-merge',
    permissions: { workspaceRole: 'owner', projectRole: null, specificModels: false, allowedModels: [], allowedLocales: [], availableTools: ['test_tool'] } as AgentPermissions,
    plan: 'starter',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    uiContext: { activeModelId: null, activeLocale: 'en', activeEntryId: null, panelState: 'overview', activeBranch: null } as ChatUIContext,
    phase: 'active' as ProjectPhase,
  }
}

/**
 * A model that wants `outputPerCall` tokens of tool calling on every
 * iteration, with a growing `promptPerCall`-token prompt. It honours
 * `max_tokens` like the API does: a call allowed fewer tokens than it
 * wants stops with `max_tokens`. With tools disabled it writes a short
 * summary.
 */
function heavyModel(opts: { promptPerCall: number, outputPerCall: number }) {
  const requests: Array<{ maxTokens: number, tools: number }> = []
  const provider: Partial<AIProvider> = {
    streamCompletion: async function* (request) {
      requests.push({ maxTokens: request.maxTokens, tools: request.tools.length })
      if (request.tools.length === 0) {
        const output = Math.min(200, request.maxTokens)
        yield { type: 'text', content: 'Summary: updated 3 entries; the rest is left for the next message.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: opts.promptPerCall, outputTokens: output, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }
        return
      }
      const output = Math.min(opts.outputPerCall, request.maxTokens)
      const truncated = output < opts.outputPerCall
      if (!truncated) {
        yield { type: 'tool_use_start', toolId: `t${requests.length}`, toolName: 'test_tool' }
        yield { type: 'tool_use_end', toolId: `t${requests.length}`, toolName: 'test_tool', toolInput: {} }
      }
      yield {
        type: 'message_end',
        stopReason: truncated ? 'max_tokens' : 'tool_use',
        usage: { inputTokens: opts.promptPerCall, outputTokens: output, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      }
    },
    createCompletion: vi.fn(),
  }
  return { provider, requests }
}

async function runLoop(provider: Partial<AIProvider>, budget?: { maxUsd: number, limitedBy?: 'turn' | 'credits' }, model: string = HAIKU) {
  stubLoopGlobals(provider)
  const { runConversationLoop } = await import('../../server/utils/conversation-engine')
  const events: Array<Record<string, unknown>> = []
  for await (const evt of runConversationLoop(
    {
      model,
      apiKey: 'sk-test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'rewrite every entry' } as AIMessage],
      tools: [{ name: 'test_tool', description: 'test', inputSchema: { type: 'object' } }],
      maxOutputTokens: 16_000,
      budget,
    },
    toolContext(),
  )) events.push(evt)
  return events
}

describe('conversation loop — turn budget', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stops an expensive turn inside its budget and closes it with a summary', async () => {
    // Starter ceiling: 30 credits = $0.90. Each iteration wants 60K of
    // prompt and 12K of output on Haiku = $0.12, so the 8 iterations +
    // wrap the loop would otherwise run cost ~$1.08.
    const { provider, requests } = heavyModel({ promptPerCall: 60_000, outputPerCall: 12_000 })

    const events = await runLoop(provider, { maxUsd: 0.9 })
    const done = events.at(-1)!
    const spent = estimateMessageCostUsd({ model: HAIKU, ...(done.usage as typeof ZERO) })

    expect(spent).toBeLessThanOrEqual(0.9)
    expect(done.stoppedBy).toBe('budget')
    // The last call was the tools-disabled summary, and the user saw it.
    expect(requests.at(-1)!.tools).toBe(0)
    const text = events.filter(e => e.type === 'text').map(e => e.content).join('')
    expect(text).toContain('Summary:')
    // No "split your operation" truncation error on a budget stop.
    expect(events.some(e => e.type === 'error')).toBe(false)
  })

  it('an Opus 5.5 turn stays inside the $1.80 ceiling and never calls with less room than thinking needs (F1/F2)', async () => {
    // Pro ceiling: 60 credits = $1.80. Opus wants 60K prompt + 12K output
    // per iteration ($0.48 at worst); 32K output ceiling as in the catalog.
    const { provider, requests } = heavyModel({ promptPerCall: 60_000, outputPerCall: 12_000 })
    stubLoopGlobals(provider)
    const { runConversationLoop } = await import('../../server/utils/conversation-engine')
    const events: Array<Record<string, unknown>> = []
    for await (const evt of runConversationLoop(
      {
        model: OPUS,
        apiKey: 'sk-test',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'rewrite every entry' } as AIMessage],
        tools: [{ name: 'test_tool', description: 'test', inputSchema: { type: 'object' } }],
        maxOutputTokens: 32_000,
        budget: { maxUsd: 1.8 },
      },
      toolContext(),
    )) events.push(evt)

    const done = events.at(-1)!
    expect(estimateMessageCostUsd({ model: OPUS, ...(done.usage as typeof ZERO) })).toBeLessThanOrEqual(1.8)
    expect(done.stoppedBy).toBe('budget')
    const floors = outputFloorsFor(OPUS)
    for (const r of requests) {
      if (r.tools > 0) expect(r.maxTokens).toBeGreaterThanOrEqual(floors.minToolCall)
      else expect(r.maxTokens).toBeGreaterThanOrEqual(floors.minClose)
    }
    expect(events.filter(e => e.type === 'text').map(e => e.content).join('')).toContain('Summary:')
  })

  it('without a budget the same turn runs all 8 iterations and the wrap', async () => {
    const { provider, requests } = heavyModel({ promptPerCall: 60_000, outputPerCall: 12_000 })

    const events = await runLoop(provider)
    const done = events.at(-1)!

    expect(requests).toHaveLength(9)
    expect(estimateMessageCostUsd({ model: HAIKU, ...(done.usage as typeof ZERO) })).toBeGreaterThan(0.9)
  })

  it('leaves a normal turn exactly as it is: full max_tokens, no stop', async () => {
    // Two tool iterations of 20K prompt / 1K output, then an answer.
    let call = 0
    const requests: number[] = []
    const provider: Partial<AIProvider> = {
      streamCompletion: async function* (request) {
        requests.push(request.maxTokens)
        call++
        if (call <= 2) {
          yield { type: 'tool_use_start', toolId: `t${call}`, toolName: 'test_tool' }
          yield { type: 'tool_use_end', toolId: `t${call}`, toolName: 'test_tool', toolInput: {} }
          yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 20_000, outputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }
          return
        }
        yield { type: 'text', content: 'Done.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20_000, outputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }
      },
      createCompletion: vi.fn(),
    }

    const events = await runLoop(provider, { maxUsd: 0.9 })

    expect(requests).toEqual([16_000, 16_000, 16_000])
    expect(events.at(-1)!.stoppedBy).toBeUndefined()
  })

  it('closes with a deterministic message when not even a summary call fits', async () => {
    // One iteration eats almost the whole $0.30 budget.
    const { provider, requests } = heavyModel({ promptPerCall: 200_000, outputPerCall: 16_000 })

    const events = await runLoop(provider, { maxUsd: 0.3 })

    expect(requests.every(r => r.tools > 0)).toBe(true)
    const text = events.filter(e => e.type === 'text').map(e => e.content).join('')
    expect(text).toContain('reached its usage limit')
    expect(events.at(-1)!.stoppedBy).toBe('budget')
  })

  it('when the month\'s credits set the budget, the close does not tell the user to send another message', async () => {
    // Same heavy turn, but the budget is the workspace's last credits.
    const wrapPrompts: string[] = []
    const { provider } = heavyModel({ promptPerCall: 60_000, outputPerCall: 12_000 })
    const inner = provider.streamCompletion!
    provider.streamCompletion = async function* (request, apiKey) {
      if (request.tools.length === 0) {
        const last = request.messages.at(-1)!
        wrapPrompts.push(JSON.stringify(last.content))
      }
      yield* inner(request, apiKey)
    }

    const events = await runLoop(provider, { maxUsd: 0.9, limitedBy: 'credits' })

    expect(events.at(-1)!.stoppedBy).toBe('credits')
    expect(wrapPrompts).toHaveLength(1)
    expect(wrapPrompts[0]).toContain('monthly AI credits')
    expect(wrapPrompts[0]).not.toContain('new message')
  })

  it('the deterministic close names the monthly credits and does not suggest a new message', async () => {
    const { provider } = heavyModel({ promptPerCall: 200_000, outputPerCall: 16_000 })

    const events = await runLoop(provider, { maxUsd: 0.3, limitedBy: 'credits' })

    const text = events.filter(e => e.type === 'text').map(e => e.content).join('')
    expect(text).toContain('monthly AI credits are used up')
    expect(text).not.toContain('Send a new message')
    expect(events.at(-1)!.stoppedBy).toBe('credits')
  })
})
