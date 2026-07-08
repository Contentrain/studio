import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const anthropicState = vi.hoisted(() => {
  const stream = vi.fn()
  const create = vi.fn()

  return {
    stream,
    create,
    Anthropic: vi.fn(function Anthropic() {
      return {
        messages: {
          stream,
          create,
        },
      }
    }),
  }
})

vi.mock('@anthropic-ai/sdk', () => ({
  default: anthropicState.Anthropic,
}))

describe('anthropic provider', () => {
  beforeEach(() => {
    vi.resetModules()
    anthropicState.stream.mockReset()
    anthropicState.create.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('normalizes Anthropic stream events into Studio stream events', async () => {
    // Real Anthropic stream order: message_start → content blocks →
    // message_delta (stop_reason + final output_tokens) → message_stop.
    // The provider emits a single normalized `message_end` once
    // message_stop fires, with all four token buckets in usage.
    anthropicState.stream.mockReturnValue((async function* () {
      yield {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }
      yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'save_content' } }
      yield { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title":"Hello"}' } }
      yield { type: 'content_block_stop' }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Saved.' } }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 20 },
      }
      yield { type: 'message_stop' }
    })())

    const { createAnthropicProvider } = await import('../../server/providers/anthropic-ai')
    const provider = createAnthropicProvider()

    const events = []
    for await (const event of provider.streamCompletion({
      model: 'claude-sonnet-4-6',
      system: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'save_content', description: 'save', inputSchema: {} }],
      maxTokens: 256,
    }, 'api-key')) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'tool_use_start', toolId: 'tool-1', toolName: 'save_content' },
      { type: 'tool_use_input', toolId: 'tool-1', content: '{"title":"Hello"}' },
      {
        type: 'tool_use_end',
        toolId: 'tool-1',
        toolName: 'save_content',
        toolInput: { title: 'Hello' },
      },
      { type: 'text', content: 'Saved.' },
      {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ])

    // Thinking must be explicitly disabled on every request: models that
    // default it ON when the field is omitted (Sonnet 5+) would emit
    // thinking blocks Studio's engine never persists or replays, breaking
    // the tool-use loop on the echoed assistant turn.
    expect(anthropicState.stream).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: { type: 'disabled' } }),
      expect.anything(),
    )
  })

  it('captures prompt cache token buckets reported by the provider', async () => {
    // Second turn of a cached conversation: most input is served
    // from cache, a small slice was newly cached, no creation this
    // turn. The provider must surface all three buckets disjointly.
    anthropicState.stream.mockReturnValue((async function* () {
      yield {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 50,
            output_tokens: 0,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 8000,
          },
        },
      }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      }
      yield { type: 'message_stop' }
    })())

    const { createAnthropicProvider } = await import('../../server/providers/anthropic-ai')
    const provider = createAnthropicProvider()
    const events: { type: string, usage?: unknown }[] = []
    for await (const event of provider.streamCompletion({
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'cached block', cacheControl: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 256,
    }, 'api-key')) {
      events.push(event)
    }

    const messageEnd = events.find(e => e.type === 'message_end')
    expect(messageEnd?.usage).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 8000,
    })
  })

  it('normalizes full Anthropic completions into Studio content blocks', async () => {
    anthropicState.create.mockResolvedValue({
      content: [
        { type: 'text', text: 'Hello there' },
        { type: 'tool_use', id: 'tool-2', name: 'brain_query', input: { model: 'posts' } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 4000,
      },
    })

    const { createAnthropicProvider } = await import('../../server/providers/anthropic-ai')
    const provider = createAnthropicProvider()

    await expect(provider.createCompletion({
      model: 'claude-sonnet-4-6',
      system: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'brain_query', description: 'query', inputSchema: {} }],
      maxTokens: 256,
    }, 'api-key')).resolves.toEqual({
      content: [
        { type: 'text', text: 'Hello there' },
        { type: 'tool_use', id: 'tool-2', name: 'brain_query', input: { model: 'posts' } },
      ],
      stopReason: 'tool_use',
      usage: {
        inputTokens: 11,
        outputTokens: 22,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 4000,
      },
    })
  })

  it('maps system block array with cache_control to Anthropic SDK shape', async () => {
    // Provider should pass blocks through with `cache_control` markers
    // preserved and tools' last entry's cacheControl mapped too.
    anthropicState.create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    const { createAnthropicProvider } = await import('../../server/providers/anthropic-ai')
    const provider = createAnthropicProvider()
    await provider.createCompletion({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'static body', cacheControl: { type: 'ephemeral' } },
        { type: 'text', text: 'brain index', cacheControl: { type: 'ephemeral' } },
        { type: 'text', text: 'dynamic body' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        { name: 'first', description: 'a', inputSchema: {} },
        { name: 'last', description: 'b', inputSchema: {}, cacheControl: { type: 'ephemeral' } },
      ],
      maxTokens: 256,
    }, 'api-key')

    const call = anthropicState.create.mock.calls[0]![0]
    expect(call.system).toEqual([
      { type: 'text', text: 'static body', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'brain index', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'dynamic body' },
    ])
    expect(call.tools[0]).not.toHaveProperty('cache_control')
    expect(call.tools[1]).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })
})
