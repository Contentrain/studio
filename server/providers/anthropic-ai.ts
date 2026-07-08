import Anthropic from '@anthropic-ai/sdk'
import type {
  AICompletionRequest,
  AICompletionResponse,
  AIContentBlock,
  AIProvider,
  AIStreamEvent,
  AISystemBlock,
  AITool,
  AIUsage,
} from './ai'

/**
 * Anthropic implementation of AIProvider.
 *
 * Uses @anthropic-ai/sdk for streaming and tool use.
 * Normalizes Anthropic-specific formats to Studio's standard events.
 *
 * Prompt cache: `AISystemBlock.cacheControl` and `AITool.cacheControl`
 * map to Anthropic's `cache_control: { type: 'ephemeral' }`. The SDK
 * returns three input-token buckets in `usage` (input, cache_creation,
 * cache_read); all four are forwarded through `AIUsage`.
 */
export function createAnthropicProvider(): AIProvider {
  return {
    async* streamCompletion(
      request: AICompletionRequest,
      apiKey: string,
    ): AsyncGenerator<AIStreamEvent> {
      const client = new Anthropic({ apiKey })

      const stream = client.messages.stream({
        model: request.model,
        system: toAnthropicSystem(request.system),
        messages: toAnthropicMessages(request.messages),
        tools: toAnthropicTools(request.tools),
        max_tokens: request.maxTokens,
        // Explicitly off, not merely omitted: newer models (Sonnet 5+)
        // default to adaptive thinking when the field is absent, and
        // Studio's engine neither persists nor replays thinking blocks
        // — an assistant turn echoed back without them would break the
        // tool-use loop.
        thinking: { type: 'disabled' },
      }, { signal: request.abortSignal })

      let currentToolId: string | undefined
      let currentToolName: string | undefined
      let currentToolInput = ''
      // `message_start` carries the initial usage snapshot (input,
      // cache_creation, cache_read). `message_delta` then carries the
      // final output_tokens and any final usage adjustments. We
      // accumulate as events arrive and emit a single normalized
      // usage payload at message_end.
      const usage: AIUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }
      let stopReason: AIStreamEvent['stopReason']

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            if ('message' in event && event.message?.usage) {
              const m = event.message.usage as {
                input_tokens?: number
                output_tokens?: number
                cache_creation_input_tokens?: number
                cache_read_input_tokens?: number
              }
              usage.inputTokens = m.input_tokens ?? 0
              usage.outputTokens = m.output_tokens ?? 0
              usage.cacheCreationInputTokens = m.cache_creation_input_tokens ?? 0
              usage.cacheReadInputTokens = m.cache_read_input_tokens ?? 0
            }
            break

          case 'content_block_start':
            if (event.content_block.type === 'text') {
              // Text block starting — nothing to emit yet
            }
            else if (event.content_block.type === 'tool_use') {
              currentToolId = event.content_block.id
              currentToolName = event.content_block.name
              currentToolInput = ''
              yield {
                type: 'tool_use_start',
                toolId: currentToolId,
                toolName: currentToolName,
              }
            }
            break

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', content: event.delta.text }
            }
            else if (event.delta.type === 'input_json_delta') {
              currentToolInput += event.delta.partial_json
              yield {
                type: 'tool_use_input',
                toolId: currentToolId,
                content: event.delta.partial_json,
              }
            }
            break

          case 'content_block_stop':
            if (currentToolId) {
              let parsedInput: unknown = null
              try {
                parsedInput = JSON.parse(currentToolInput)
              }
              catch {
                parsedInput = currentToolInput
              }
              yield {
                type: 'tool_use_end',
                toolId: currentToolId,
                toolName: currentToolName,
                toolInput: parsedInput,
              }
              currentToolId = undefined
              currentToolName = undefined
              currentToolInput = ''
            }
            break

          case 'message_delta':
            if ('usage' in event) {
              const d = event.usage as { output_tokens?: number, input_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number }
              // Anthropic spec: message_delta carries output_tokens
              // (and sometimes a refined input bucket). Add to what
              // message_start already captured rather than overwriting.
              if (typeof d.output_tokens === 'number') usage.outputTokens = d.output_tokens
              if (typeof d.input_tokens === 'number') usage.inputTokens = d.input_tokens
              if (typeof d.cache_creation_input_tokens === 'number') usage.cacheCreationInputTokens = d.cache_creation_input_tokens
              if (typeof d.cache_read_input_tokens === 'number') usage.cacheReadInputTokens = d.cache_read_input_tokens
            }
            stopReason = (event.delta as { stop_reason?: string }).stop_reason as AIStreamEvent['stopReason']
            break

          case 'message_stop':
            yield {
              type: 'message_end',
              stopReason,
              usage,
            }
            break
        }
      }
    },

    async createCompletion(
      request: AICompletionRequest,
      apiKey: string,
    ): Promise<AICompletionResponse> {
      const client = new Anthropic({ apiKey })

      const response = await client.messages.create({
        model: request.model,
        system: toAnthropicSystem(request.system),
        messages: toAnthropicMessages(request.messages),
        tools: toAnthropicTools(request.tools),
        max_tokens: request.maxTokens,
        // See streamCompletion — thinking must be explicitly disabled.
        thinking: { type: 'disabled' },
      }, { signal: request.abortSignal })

      const respUsage = response.usage as {
        input_tokens: number
        output_tokens: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }

      return {
        content: fromAnthropicContent(response.content),
        stopReason: response.stop_reason as AICompletionResponse['stopReason'],
        usage: {
          inputTokens: respUsage.input_tokens,
          outputTokens: respUsage.output_tokens,
          cacheCreationInputTokens: respUsage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: respUsage.cache_read_input_tokens ?? 0,
        },
      }
    },
  }
}

/**
 * Convert Studio system input (string or block array) to Anthropic's
 * `string | TextBlockParam[]`. Cache markers map directly.
 */
function toAnthropicSystem(system: string | AISystemBlock[]): string | Anthropic.TextBlockParam[] {
  if (typeof system === 'string') return system
  return system.map(block => ({
    type: 'text' as const,
    text: block.text,
    ...(block.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }))
}

/**
 * Convert Studio messages to Anthropic format. Exported for unit
 * testing of the content-block mapping (image/document/tool blocks).
 */
export function toAnthropicMessages(messages: AICompletionRequest['messages']): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content }
    }

    // Convert content blocks
    const blocks: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text' as const, text: block.text }
        case 'tool_use':
          return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input as Record<string, unknown> }
        case 'tool_result':
          return { type: 'tool_result' as const, tool_use_id: block.toolUseId, content: block.content }
        case 'image':
          return block.source.type === 'url'
            ? { type: 'image' as const, source: { type: 'url' as const, url: block.source.url } }
            : { type: 'image' as const, source: { type: 'base64' as const, media_type: block.source.mediaType, data: block.source.data } }
        case 'document':
          return { type: 'document' as const, source: { type: 'base64' as const, media_type: block.source.mediaType, data: block.source.data } }
        default:
          return { type: 'text' as const, text: '' }
      }
    })

    return { role: msg.role, content: blocks }
  })
}

/**
 * Convert Studio tools to Anthropic format. The optional `cacheControl`
 * on a tool maps to Anthropic's `cache_control` and is honored only on
 * the last tool — placing it earlier would split the cached prefix and
 * cost extra creation writes. Studio callers conventionally mark only
 * the final tool.
 */
function toAnthropicTools(tools: AITool[]): Anthropic.Tool[] {
  return tools.map((tool): Anthropic.Tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    ...(tool.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }))
}

/**
 * Convert Anthropic content blocks to Studio format.
 */
function fromAnthropicContent(content: Anthropic.ContentBlock[]): AIContentBlock[] {
  return content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text }
    }
    if (block.type === 'tool_use') {
      return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input }
    }
    return { type: 'text' as const, text: '' }
  })
}
