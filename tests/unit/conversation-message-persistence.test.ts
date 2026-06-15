import type { MessageInsertInput } from '../../server/providers/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture what gets handed to the Supabase client so we can assert the
// exact row shape that reaches PostgREST.
const { insertSpy } = vi.hoisted(() => ({ insertSpy: vi.fn() }))

vi.mock('../../server/providers/supabase-db/helpers', () => ({
  getAdmin: () => ({ from: () => ({ insert: insertSpy }) }),
  getUser: () => ({ from: () => ({}) }),
}))

/**
 * Regression coverage for the silent chat-trace persistence loss.
 *
 * The trace insert builds heterogeneous rows (a seed user row, an
 * intermediate assistant/tool_result pair, a final assistant row with
 * tokens + model). PostgREST rejects a bulk insert whose objects don't
 * all share the same key set (`PGRST102: All object keys must match`),
 * and the old code never inspected the returned `{ error }`, so the
 * whole conversation trace vanished without a throw or a log.
 */
describe('conversation message persistence', () => {
  beforeEach(() => {
    insertSpy.mockReset()
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => new Error(input.message))
  })

  const heterogeneousTrace: MessageInsertInput[] = [
    { conversationId: 'c1', role: 'user', content: 'add a blog post', turnId: 't1', turnSequence: 0, internal: false },
    { conversationId: 'c1', role: 'assistant', content: '[tool calls]', contentBlocks: [{ type: 'tool_use', id: 'tu', name: 'save_content', input: { slug: 'x' } }], turnId: 't1', turnSequence: 1, iteration: 1, internal: true },
    { conversationId: 'c1', role: 'user', content: '[tool results]', contentBlocks: [{ type: 'tool_result', toolUseId: 'tu', content: '{"merged":true}' }], turnId: 't1', turnSequence: 2, iteration: 1, internal: true },
    { conversationId: 'c1', role: 'assistant', content: 'Done', contentBlocks: [{ type: 'text', text: 'Done' }], turnId: 't1', turnSequence: 3, iteration: 2, internal: false, tokenCountInput: 100, tokenCountOutput: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 9, model: 'claude-haiku-4-5-20251001' },
  ]

  it('emits an identical column key set for every row in a heterogeneous trace', async () => {
    insertSpy.mockResolvedValue({ error: null })
    const { conversationMethods } = await import('../../server/providers/supabase-db/conversations')

    await conversationMethods().insertMessages(heterogeneousTrace)

    const rows = insertSpy.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(4)

    // The core PGRST102 guard: all rows must carry the same keys.
    const keySets = rows.map(r => Object.keys(r).sort().join(','))
    expect(new Set(keySets).size).toBe(1)

    // NOT NULL token counters (migrations 008/009) must default to 0,
    // never null, on rows that don't carry real values.
    for (const r of rows) {
      expect(r.cache_creation_input_tokens).not.toBeNull()
      expect(r.cache_read_input_tokens).not.toBeNull()
      expect(typeof r.cache_creation_input_tokens).toBe('number')
      expect(typeof r.cache_read_input_tokens).toBe('number')
    }

    // Nullable columns stay null when absent; real values pass through.
    expect(rows[0]!.content_blocks).toBeNull()
    expect(rows[0]!.model).toBeNull()
    expect(rows[3]!.model).toBe('claude-haiku-4-5-20251001')
    expect(rows[3]!.cache_read_input_tokens).toBe(9)
  })

  it('throws instead of silently dropping when the insert returns an error', async () => {
    insertSpy.mockResolvedValue({ error: { message: 'All object keys must match' } })
    const { conversationMethods } = await import('../../server/providers/supabase-db/conversations')

    await expect(conversationMethods().insertMessages(heterogeneousTrace)).rejects.toThrow(/All object keys must match/)
  })

  it('is a no-op for an empty batch', async () => {
    const { conversationMethods } = await import('../../server/providers/supabase-db/conversations')
    await conversationMethods().insertMessages([])
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
