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
    anthropicState.stream.mockReturnValue((async function* () {
      yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'save_content' } }
      yield { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title":"Hello"}' } }
      yield { type: 'content_block_stop' }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Saved.' } }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 10, output_tokens: 20 },
      }
    })())

    const { createAnthropicProvider } = await import('../../server/providers/anthropic-ai')
    const provider = createAnthropicProvider()

    const events = []
    for await (const event of provider.streamCompletion({
      model: 'claude-sonnet-4-20250514',
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
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ])
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
      },
    })

    const { createAnthropicProvider } = await import('../../server/providers/anthropic-ai')
    const provider = createAnthropicProvider()

    await expect(provider.createCompletion({
      model: 'claude-sonnet-4-20250514',
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
      usage: { inputTokens: 11, outputTokens: 22 },
    })
  })
})
