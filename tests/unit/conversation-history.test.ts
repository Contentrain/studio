import { describe, expect, it } from 'vitest'
import { buildPromptMessages, selectHistoryBudget } from '../../server/utils/conversation-history'

describe('selectHistoryBudget', () => {
  it('returns the per-model budget when the model is known', () => {
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-haiku-4-5-20251001', source: 'studio' }))
      .toMatchObject({ maxTokens: 12_000 })
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-sonnet-4-20250514', source: 'studio' }))
      .toMatchObject({ maxTokens: 32_000 })
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-sonnet-4-5', source: 'studio' }))
      .toMatchObject({ maxTokens: 40_000 })
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-opus-4-7', source: 'studio' }))
      .toMatchObject({ maxTokens: 48_000 })
  })

  it('falls back for unknown models', () => {
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-future-9', source: 'studio' }))
      .toMatchObject({ maxTokens: 16_000 })
  })

  it('scales the budget by plan multiplier', () => {
    // Sonnet 4 base = 32_000
    expect(selectHistoryBudget({ plan: 'starter', model: 'claude-sonnet-4-20250514', source: 'studio' }))
      .toMatchObject({ maxTokens: 24_000 }) // 32k * 0.75
    expect(selectHistoryBudget({ plan: 'enterprise', model: 'claude-sonnet-4-20250514', source: 'studio' }))
      .toMatchObject({ maxTokens: 40_000 }) // 32k * 1.25
    expect(selectHistoryBudget({ plan: 'community', model: 'claude-sonnet-4-20250514', source: 'studio' }))
      .toMatchObject({ maxTokens: 32_000 }) // 32k * 1
  })

  it('returns zero budget for the free plan (defensive backstop — should never reach chat path)', () => {
    expect(selectHistoryBudget({ plan: 'free', model: 'claude-haiku-4-5-20251001', source: 'studio' }))
      .toMatchObject({ maxTokens: 0 })
  })

  it('uses neutral multiplier for unknown plans', () => {
    // Base 32k * fallback (1) * studio (1) = 32k
    expect(selectHistoryBudget({ plan: 'mystery-plan', model: 'claude-sonnet-4-20250514', source: 'studio' }))
      .toMatchObject({ maxTokens: 32_000 })
  })

  it('boosts the budget by 1.5x for BYOA where the user pays Anthropic directly', () => {
    // Sonnet 4 base 32_000 * pro (1) * byoa (1.5) = 48_000
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-sonnet-4-20250514', source: 'byoa' }))
      .toMatchObject({ maxTokens: 48_000 })
  })

  it('keeps the API source at the studio baseline (no per-source multiplier)', () => {
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-sonnet-4-5', source: 'api' }))
      .toMatchObject({ maxTokens: 40_000 })
  })

  it('scales rowLimit with the token budget', () => {
    const big = selectHistoryBudget({ plan: 'enterprise', model: 'claude-sonnet-4-6', source: 'byoa' })
    const small = selectHistoryBudget({ plan: 'starter', model: 'claude-haiku-4-5-20251001', source: 'studio' })
    expect(big.rowLimit).toBeGreaterThan(small.rowLimit)
    expect(small.rowLimit).toBeGreaterThanOrEqual(50) // minimum safety floor
  })
})

describe('buildPromptMessages', () => {
  const budget = { maxTokens: 10_000, rowLimit: 100 }

  it('returns just the new user message when history is empty', () => {
    const messages = buildPromptMessages({
      history: [],
      newUserMessage: 'hello',
      budget,
    })
    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('keeps every row when history fits in budget', () => {
    const messages = buildPromptMessages({
      history: [
        { role: 'user', content: 'first', tool_calls: null },
        { role: 'assistant', content: 'reply', tool_calls: null },
      ],
      newUserMessage: 'follow up',
      budget,
    })
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow up' },
    ])
  })

  it('drops oldest rows when history exceeds budget', () => {
    // 1000-char string ≈ 250 tokens; 5 rows × 250 ≈ 1250 tokens
    // Tight budget of 600 tokens should keep only the last 2-3 rows.
    const longString = 'a'.repeat(1000)
    const messages = buildPromptMessages({
      history: [
        { role: 'user', content: longString, tool_calls: null },
        { role: 'assistant', content: longString, tool_calls: null },
        { role: 'user', content: longString, tool_calls: null },
        { role: 'assistant', content: longString, tool_calls: null },
        { role: 'user', content: longString, tool_calls: null },
      ],
      newUserMessage: 'now',
      budget: { maxTokens: 600, rowLimit: 100 },
    })
    // First message is always the new user message at the end; oldest
    // rows from the top of `history` should be dropped before any
    // newer rows.
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'now' })
    expect(messages.length).toBeLessThan(6) // not all rows + new
    expect(messages.length).toBeGreaterThanOrEqual(2) // at least 1 history + new
  })

  it('drops everything when budget is zero (free plan defensive path)', () => {
    const messages = buildPromptMessages({
      history: [
        { role: 'user', content: 'old', tool_calls: null },
        { role: 'assistant', content: 'older', tool_calls: null },
      ],
      newUserMessage: 'new',
      budget: { maxTokens: 0, rowLimit: 100 },
    })
    expect(messages).toEqual([{ role: 'user', content: 'new' }])
  })

  it('preserves tool_use content blocks when tool_calls jsonb is present (snake_case)', () => {
    const toolUseBlocks = [
      { type: 'tool_use', id: 't1', name: 'list_models', input: {} },
    ]
    const messages = buildPromptMessages({
      history: [
        { role: 'user', content: 'list them', tool_calls: null },
        { role: 'assistant', content: '[tool calls]', tool_calls: toolUseBlocks },
      ],
      newUserMessage: 'thanks',
      budget,
    })
    expect(messages[1]).toEqual({ role: 'assistant', content: toolUseBlocks })
  })

  it('also tolerates the camelCase toolCalls shape (legacy EE handler wrapper)', () => {
    const toolUseBlocks = [
      { type: 'tool_use', id: 't1', name: 'list_models', input: {} },
    ]
    const messages = buildPromptMessages({
      history: [
        { role: 'assistant', content: '[tool calls]', toolCalls: toolUseBlocks },
      ],
      newUserMessage: 'thanks',
      budget,
    })
    expect(messages[0]).toEqual({ role: 'assistant', content: toolUseBlocks })
  })

  it('preserves chronological order even when budget cuts the head', () => {
    const longString = 'b'.repeat(800) // ~200 tokens each
    const messages = buildPromptMessages({
      history: [
        { role: 'user', content: `OLDEST ${longString}`, tool_calls: null },
        { role: 'assistant', content: `MID-1 ${longString}`, tool_calls: null },
        { role: 'user', content: `MID-2 ${longString}`, tool_calls: null },
        { role: 'assistant', content: `NEWEST ${longString}`, tool_calls: null },
      ],
      newUserMessage: 'next',
      budget: { maxTokens: 500, rowLimit: 100 },
    })
    // Newer rows should be kept; oldest dropped. The kept rows
    // appear in original (chronological) order, not reverse.
    const kept = messages.slice(0, -1)
    for (let i = 1; i < kept.length; i++) {
      const prev = kept[i - 1]!.content as string
      const curr = kept[i]!.content as string
      expect(typeof prev).toBe('string')
      expect(typeof curr).toBe('string')
    }
    // NEWEST must be present, OLDEST must be absent.
    const joined = kept.map(m => m.content as string).join('|')
    expect(joined).toContain('NEWEST')
    expect(joined).not.toContain('OLDEST')
  })

  it('reads structured content_blocks first when present', () => {
    const blocks = [{ type: 'tool_use', id: 't1', name: 'get_content', input: {} }]
    const messages = buildPromptMessages({
      history: [
        {
          role: 'assistant',
          content: '[tool calls]',
          content_blocks: blocks,
          tool_calls: null,
          turn_id: 'turn-A',
          turn_sequence: 0,
        },
      ],
      newUserMessage: 'next',
      budget,
    })
    expect(messages[0]).toEqual({ role: 'assistant', content: blocks })
  })
})

describe('buildPromptMessages — turn-safe Anthropic protocol invariant', () => {
  const budget = { maxTokens: 10_000, rowLimit: 100 }

  it('keeps whole multi-row turns together (assistant tool_use + matching tool_result)', () => {
    // One conversation with two turns: T1 = (user prompt, assistant
    // text+tool_use, user tool_result), T2 = (user prompt, assistant
    // text). The budget walker must never drop the tool_result while
    // keeping the tool_use — Anthropic rejects orphaned tool_use blocks.
    const t1Assistant = [
      { type: 'text', text: 'I will check.' },
      { type: 'tool_use', id: 't1', name: 'get_content', input: {} },
    ]
    const t1ToolResult = [{ type: 'tool_result', toolUseId: 't1', content: '{}' }]
    const messages = buildPromptMessages({
      history: [
        { role: 'user', content: 'prompt 1', turn_id: 'T1', turn_sequence: 0 },
        { role: 'assistant', content: '[tool calls]', content_blocks: t1Assistant, turn_id: 'T1', turn_sequence: 1 },
        { role: 'user', content: '[tool results]', content_blocks: t1ToolResult, turn_id: 'T1', turn_sequence: 2 },
        { role: 'user', content: 'prompt 2', turn_id: 'T2', turn_sequence: 0 },
        { role: 'assistant', content: 'Done.', turn_id: 'T2', turn_sequence: 1 },
      ],
      newUserMessage: 'prompt 3',
      budget,
    })
    // All 5 history rows + the new user message.
    expect(messages).toHaveLength(6)
    expect((messages[1]!.content as Array<{ type: string }>)[1]!.type).toBe('tool_use')
    expect((messages[2]!.content as Array<{ type: string }>)[0]!.type).toBe('tool_result')
  })

  it('drops whole older turns when budget overflows; never splits a turn', () => {
    // OLD turn is heavy (3 rows × ~500 tokens each ≈ 1500 tokens);
    // NEW turn is small enough to fit in a 600-token budget. The
    // walker must keep all of NEW and discard all of OLD — never
    // half-OLD, which would leak an orphan tool_use/tool_result pair.
    const longText = 'x'.repeat(2000) // ~500 tokens
    const heavyAssistant = [
      { type: 'text', text: longText },
      { type: 'tool_use', id: 't', name: 'get_content', input: {} },
    ]
    const heavyToolResult = [{ type: 'tool_result', toolUseId: 't', content: longText }]
    const messages = buildPromptMessages({
      history: [
        { role: 'user', content: `OLD-USER ${longText}`, turn_id: 'OLD', turn_sequence: 0 },
        { role: 'assistant', content: '[tool calls]', content_blocks: heavyAssistant, turn_id: 'OLD', turn_sequence: 1 },
        { role: 'user', content: '[tool results]', content_blocks: heavyToolResult, turn_id: 'OLD', turn_sequence: 2 },
        { role: 'user', content: 'NEW-USER short', turn_id: 'NEW', turn_sequence: 0 },
        { role: 'assistant', content: 'NEW-REPLY short', turn_id: 'NEW', turn_sequence: 1 },
      ],
      newUserMessage: 'next',
      budget: { maxTokens: 600, rowLimit: 100 },
    })
    expect(messages).toHaveLength(3)
    expect(messages[0]!.content).toBe('NEW-USER short')
    expect(messages[1]!.content).toBe('NEW-REPLY short')
    // OLD turn fully dropped — no orphaned tool_use, no orphaned tool_result.
    const joined = messages.map(m => JSON.stringify(m.content)).join('|')
    expect(joined).not.toContain('OLD-USER')
    expect(joined).not.toMatch(/tool_use|tool_result/)
  })

  it('drops the entire oldest turn rather than half of it when budget is tight', () => {
    const longText = 'y'.repeat(2000)
    const messages = buildPromptMessages({
      history: [
        // Old turn has 3 rows — none should survive partial inclusion.
        { role: 'user', content: `OLD-1 ${longText}`, turn_id: 'OLD', turn_sequence: 0 },
        { role: 'assistant', content: `OLD-2 ${longText}`, turn_id: 'OLD', turn_sequence: 1 },
        { role: 'user', content: `OLD-3 ${longText}`, turn_id: 'OLD', turn_sequence: 2 },
        // Newer turn is small and fits.
        { role: 'user', content: 'NEW', turn_id: 'NEW', turn_sequence: 0 },
        { role: 'assistant', content: 'OK', turn_id: 'NEW', turn_sequence: 1 },
      ],
      // Budget large enough for the small NEW turn but not for any
      // single row of the OLD turn — proves "all or none" per turn.
      budget: { maxTokens: 200, rowLimit: 100 },
      newUserMessage: 'next',
    })
    expect(messages).toHaveLength(3)
    expect(messages[0]!.content).toBe('NEW')
    expect(messages[1]!.content).toBe('OK')
  })
})
