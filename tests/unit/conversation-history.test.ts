import { describe, expect, it } from 'vitest'
import { PROMPT_CACHE_CONTROL } from '../../server/providers/ai'
import { buildPromptMessages, estimateContentTokens, selectHistoryBudget, stripHistoricalImages } from '../../server/utils/conversation-history'

/**
 * Text of a message regardless of shape — the cache marker turns the
 * history tail into a block array even when the row was plain text.
 */
function textOf(message: { content: unknown }): string {
  if (typeof message.content === 'string') return message.content
  return (message.content as Array<{ type: string, text?: string }>)
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('')
}

describe('selectHistoryBudget', () => {
  it('returns the per-model budget when the model is known', () => {
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-haiku-4-5-20251001', source: 'studio' }))
      .toMatchObject({ maxTokens: 24_000 })
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-opus-4-1-20250805', source: 'studio' }))
      .toMatchObject({ maxTokens: 32_000 })
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-sonnet-4-5', source: 'studio' }))
      .toMatchObject({ maxTokens: 40_000 })
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-opus-4-7', source: 'studio' }))
      .toMatchObject({ maxTokens: 48_000 })
    // Catalog-sourced entries (shared/utils/ai-models.ts) — the replayed
    // history is served from the prompt cache, so the window is wide.
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-sonnet-4-6', source: 'studio' }))
      .toMatchObject({ maxTokens: 96_000 })
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-sonnet-5', source: 'studio' }))
      .toMatchObject({ maxTokens: 96_000 })
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-opus-4-8', source: 'studio' }))
      .toMatchObject({ maxTokens: 96_000 })
  })

  it('falls back for unknown models', () => {
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-future-9', source: 'studio' }))
      .toMatchObject({ maxTokens: 16_000 })
  })

  it('scales the budget by plan multiplier', () => {
    // Opus 4.1 base = 32_000
    expect(selectHistoryBudget({ plan: 'starter', model: 'claude-opus-4-1-20250805', source: 'studio' }))
      .toMatchObject({ maxTokens: 24_000 }) // 32k * 0.75
    expect(selectHistoryBudget({ plan: 'enterprise', model: 'claude-opus-4-1-20250805', source: 'studio' }))
      .toMatchObject({ maxTokens: 40_000 }) // 32k * 1.25
    expect(selectHistoryBudget({ plan: 'community', model: 'claude-opus-4-1-20250805', source: 'studio' }))
      .toMatchObject({ maxTokens: 32_000 }) // 32k * 1
  })

  it('returns zero budget for the free plan (defensive backstop — should never reach chat path)', () => {
    expect(selectHistoryBudget({ plan: 'free', model: 'claude-haiku-4-5-20251001', source: 'studio' }))
      .toMatchObject({ maxTokens: 0 })
  })

  it('uses neutral multiplier for unknown plans', () => {
    // Base 32k * fallback (1) * studio (1) = 32k
    expect(selectHistoryBudget({ plan: 'mystery-plan', model: 'claude-opus-4-1-20250805', source: 'studio' }))
      .toMatchObject({ maxTokens: 32_000 })
  })

  it('boosts the budget by 1.5x for BYOA where the user pays Anthropic directly', () => {
    // Opus 4.1 base 32_000 * pro (1) * byoa (1.5) = 48_000
    expect(selectHistoryBudget({ plan: 'pro', model: 'claude-opus-4-1-20250805', source: 'byoa' }))
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

  it('keeps every row when history fits in budget and marks the history tail as the cache breakpoint', () => {
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
      { role: 'assistant', content: [{ type: 'text', text: 'reply', cacheControl: PROMPT_CACHE_CONTROL }] },
      { role: 'user', content: 'follow up' },
    ])
  })

  it('drops oldest rows when history exceeds budget', () => {
    // 1000-char string ≈ 290 tokens; 5 rows ≈ 1450 tokens.
    // Tight budget of 600 tokens must keep only the newest rows.
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
    // The new user message is always last; oldest rows from the top of
    // `history` are dropped before any newer rows.
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
    const toolUse = { type: 'tool_use', id: 't1', name: 'list_models', input: {} }
    const messages = buildPromptMessages({
      history: [
        { role: 'user', content: 'list them', tool_calls: null },
        { role: 'assistant', content: '[tool calls]', tool_calls: [toolUse] },
      ],
      newUserMessage: 'thanks',
      budget,
    })
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ ...toolUse, cacheControl: PROMPT_CACHE_CONTROL }] })
  })

  it('also tolerates the camelCase toolCalls shape (legacy EE handler wrapper)', () => {
    const toolUse = { type: 'tool_use', id: 't1', name: 'list_models', input: {} }
    const messages = buildPromptMessages({
      history: [
        { role: 'assistant', content: '[tool calls]', toolCalls: [toolUse] },
      ],
      newUserMessage: 'thanks',
      budget,
    })
    expect(messages[0]).toEqual({ role: 'assistant', content: [{ ...toolUse, cacheControl: PROMPT_CACHE_CONTROL }] })
  })

  it('preserves chronological order even when budget cuts the head', () => {
    const longString = 'b'.repeat(800) // ~230 tokens each
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
    // Newer rows are kept, the oldest dropped, and kept rows appear in
    // original (chronological) order, not reverse.
    const kept = messages.slice(0, -1).map(textOf)
    const joined = kept.join('|')
    expect(joined).toContain('NEWEST')
    expect(joined).not.toContain('OLDEST')
    const mid = kept.findIndex(t => t.startsWith('MID-2'))
    if (mid >= 0) expect(mid).toBeLessThan(kept.findIndex(t => t.startsWith('NEWEST')))
  })

  it('reads structured content_blocks first when present', () => {
    const toolUse = { type: 'tool_use', id: 't1', name: 'get_content', input: {} }
    const messages = buildPromptMessages({
      history: [
        {
          role: 'assistant',
          content: '[tool calls]',
          content_blocks: [toolUse],
          tool_calls: null,
          turn_id: 'turn-A',
          turn_sequence: 0,
        },
      ],
      newUserMessage: 'next',
      budget,
    })
    expect(messages[0]).toEqual({ role: 'assistant', content: [{ ...toolUse, cacheControl: PROMPT_CACHE_CONTROL }] })
  })

  it('accepts an AIContentBlock[] as the new user message (attachments)', () => {
    const userBlocks = [
      { type: 'text', text: '[Attached file: notes.txt]\nfoo' },
      { type: 'text', text: 'summarize this' },
    ]
    const messages = buildPromptMessages({
      history: [],
      newUserMessage: userBlocks,
      budget,
    })
    expect(messages).toEqual([{ role: 'user', content: userBlocks }])
  })
})

describe('buildPromptMessages — prompt cache layout', () => {
  const budget = { maxTokens: 10_000, rowLimit: 100 }

  it('marks only the last non-empty block of the history tail', () => {
    const messages = buildPromptMessages({
      history: [
        {
          role: 'assistant',
          content: 'x',
          content_blocks: [
            { type: 'text', text: 'first' },
            { type: 'tool_use', id: 't', name: 'get_content', input: {} },
            { type: 'text', text: '   ' },
          ],
          turn_id: 'T',
          turn_sequence: 0,
        },
      ],
      newUserMessage: 'next',
      budget,
    })
    const content = messages[0]!.content as Array<Record<string, unknown>>
    expect(content[0]).not.toHaveProperty('cacheControl')
    expect(content[1]).toMatchObject({ type: 'tool_use', cacheControl: PROMPT_CACHE_CONTROL })
    expect(content[2]).toEqual({ type: 'text', text: '   ' })
  })

  it('never marks the current user turn', () => {
    const messages = buildPromptMessages({
      history: [{ role: 'user', content: 'earlier', turn_id: 'T', turn_sequence: 0 }],
      newUserMessage: [{ type: 'text', text: 'now' }],
      budget,
    })
    expect(JSON.stringify(messages.at(-1))).not.toContain('cacheControl')
    expect(JSON.stringify(messages[0])).toContain('cacheControl')
  })

  it('prepends the request context to a plain-string user message', () => {
    const context = '<request_context>\nctx\n</request_context>'
    const messages = buildPromptMessages({ history: [], newUserMessage: 'hello', budget, requestContext: context })
    expect(messages).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: context }, { type: 'text', text: 'hello' }],
    }])
  })

  it('prepends the request context before attachment blocks', () => {
    const image = { type: 'image', source: { type: 'url', url: 'https://cdn.example/media/x.png' } }
    const messages = buildPromptMessages({
      history: [],
      newUserMessage: [image, { type: 'text', text: 'set this as cover' }],
      budget,
      requestContext: 'CTX',
    })
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'CTX' },
      image,
      { type: 'text', text: 'set this as cover' },
    ])
  })

  it('ignores an empty request context', () => {
    expect(buildPromptMessages({ history: [], newUserMessage: 'hi', budget, requestContext: '  \n' }))
      .toEqual([{ role: 'user', content: 'hi' }])
    expect(buildPromptMessages({ history: [], newUserMessage: 'hi', budget, requestContext: null }))
      .toEqual([{ role: 'user', content: 'hi' }])
  })

  it('trims with hysteresis: an overflow cuts well under the budget, not just under it', () => {
    // 10 single-row turns of ~305 tokens each. Exact-fit trimming would
    // keep 4 turns (≈1220 ≤ 1500) and then drop one more on every
    // subsequent turn, shifting the cached prefix each call. Hysteresis
    // keeps 75% of the budget (≈1125) → 3 turns.
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `${i}:${'a'.repeat(1050)}`,
      turn_id: `T${i}`,
      turn_sequence: 0,
    }))
    const messages = buildPromptMessages({ history, newUserMessage: 'next', budget: { maxTokens: 1500, rowLimit: 100 } })
    expect(messages.length - 1).toBe(3)
    expect(textOf(messages[0]!)).toMatch(/^7:/)
  })

  it('never drops the newest turn while it fits the budget on its own', () => {
    // Newest turn ≈ 904 tokens — over the 75% target (750) but under the
    // 1000 budget. It must survive; only the older turn goes.
    const history = [
      { role: 'user', content: `OLD ${'a'.repeat(1050)}`, turn_id: 'OLD', turn_sequence: 0 },
      { role: 'user', content: `NEW ${'a'.repeat(3150)}`, turn_id: 'NEW', turn_sequence: 0 },
    ]
    const messages = buildPromptMessages({ history, newUserMessage: 'next', budget: { maxTokens: 1000, rowLimit: 100 } })
    expect(messages).toHaveLength(2)
    expect(textOf(messages[0]!)).toMatch(/^NEW /)
  })

  it('keeps everything while the history still fits, even exactly at the ceiling', () => {
    const history = Array.from({ length: 3 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `${i}:${'a'.repeat(1050)}`,
      turn_id: `T${i}`,
      turn_sequence: 0,
    }))
    const messages = buildPromptMessages({ history, newUserMessage: 'next', budget: { maxTokens: 915, rowLimit: 100 } })
    expect(messages.length - 1).toBe(3)
  })
})

describe('stripHistoricalImages', () => {
  it('replaces base64 image blocks with a placeholder', () => {
    const out = stripHistoricalImages([
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/webp', data: 'AAAA' } },
    ], { keepUrlImages: true })
    expect(out[0]).toEqual({ type: 'text', text: 'hi' })
    expect(out[1]).toEqual({ type: 'text', text: '[image attached earlier]' })
  })

  it('keeps URL image blocks for recent turns', () => {
    const blocks = [{ type: 'image', source: { type: 'url', url: 'https://cdn.example/media/x.png' } }]
    const out = stripHistoricalImages(blocks as never, { keepUrlImages: true })
    expect(out).toBe(blocks) // unchanged reference when nothing stripped
  })

  it('replaces older URL images with a placeholder that keeps the URL as a reference', () => {
    const out = stripHistoricalImages(
      [{ type: 'image', source: { type: 'url', url: 'https://cdn.example/media/x.png' } }],
      { keepUrlImages: false },
    )
    expect(out).toEqual([{ type: 'text', text: '[image attached earlier: https://cdn.example/media/x.png]' }])
  })

  it('history replay keeps URL images only in the newest turn', () => {
    const messages = buildPromptMessages({
      history: [
        {
          role: 'user',
          content: 'old cover',
          content_blocks: [
            { type: 'image', source: { type: 'base64', mediaType: 'image/webp', data: 'BIG' } },
            { type: 'image', source: { type: 'url', url: 'https://cdn.example/media/old.png' } },
            { type: 'text', text: 'old cover' },
          ],
          turn_id: 'T1',
          turn_sequence: 0,
        },
        { role: 'assistant', content: 'saved', turn_id: 'T1', turn_sequence: 1 },
        {
          role: 'user',
          content: 'new cover',
          content_blocks: [
            { type: 'image', source: { type: 'url', url: 'https://cdn.example/media/new.png' } },
            { type: 'text', text: 'new cover' },
          ],
          turn_id: 'T2',
          turn_sequence: 0,
        },
        { role: 'assistant', content: 'saved again', turn_id: 'T2', turn_sequence: 1 },
      ],
      newUserMessage: 'next',
      budget: { maxTokens: 10_000, rowLimit: 100 },
    })
    const older = messages[0]!.content as Array<{ type: string, text?: string, source?: { type: string } }>
    expect(older[0]).toEqual({ type: 'text', text: '[image attached earlier]' })
    expect(older[1]).toEqual({ type: 'text', text: '[image attached earlier: https://cdn.example/media/old.png]' })
    expect(older[2]).toEqual({ type: 'text', text: 'old cover' })
    const newest = messages[2]!.content as Array<{ type: string, source?: { type: string, url?: string } }>
    expect(newest[0]!.type).toBe('image')
    expect(newest[0]!.source!.url).toBe('https://cdn.example/media/new.png')
  })
})

describe('estimateContentTokens', () => {
  it('counts non-ASCII text denser than ASCII of the same length', () => {
    const ascii = 'a'.repeat(400)
    const turkish = 'ş'.repeat(400)
    expect(estimateContentTokens(turkish)).toBeGreaterThan(estimateContentTokens(ascii) * 2)
  })

  it('bills an image block at the provider ceiling, not at its JSON length', () => {
    const url = estimateContentTokens([{ type: 'image', source: { type: 'url', url: 'https://cdn.example/x.png' } }])
    const inline = estimateContentTokens([{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }])
    expect(url).toBeGreaterThanOrEqual(1_500)
    expect(inline).toBe(url)
  })

  it('counts tool_use input by its serialized size', () => {
    const tokens = estimateContentTokens([{ type: 'tool_use', id: 't', name: 'save_content', input: { body: 'x'.repeat(3500) } }])
    expect(tokens).toBeGreaterThan(1_000)
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
    // OLD turn is heavy (3 rows × ~570 tokens each); NEW turn is small
    // enough to fit in a 600-token budget. The walker must keep all of
    // NEW and discard all of OLD — never half-OLD, which would leak an
    // orphan tool_use/tool_result pair.
    const longText = 'x'.repeat(2000)
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
    expect(textOf(messages[1]!)).toBe('NEW-REPLY short')
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
    expect(textOf(messages[1]!)).toBe('OK')
  })
})
