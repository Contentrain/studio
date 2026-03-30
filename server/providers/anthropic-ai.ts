import Anthropic from '@anthropic-ai/sdk'
import type {
  AICompletionRequest,
  AICompletionResponse,
  AIContentBlock,
  AIProvider,
  AIStreamEvent,
} from './ai'

/**
 * Anthropic implementation of AIProvider.
 *
 * Uses @anthropic-ai/sdk for streaming and tool use.
 * Normalizes Anthropic-specific formats to Studio's standard events.
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
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        tools: toAnthropicTools(request.tools),
        max_tokens: request.maxTokens,
      }, { signal: request.abortSignal })

      let currentToolId: string | undefined
      let currentToolName: string | undefined
      let currentToolInput = ''

      for await (const event of stream) {
        switch (event.type) {
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

          case 'message_stop':
            break

          case 'message_delta':
            if ('usage' in event) {
              yield {
                type: 'message_end',
                stopReason: (event.delta as { stop_reason?: string }).stop_reason as AIStreamEvent['stopReason'],
                usage: {
                  inputTokens: (event.usage as { input_tokens?: number }).input_tokens ?? 0,
                  outputTokens: (event.usage as { output_tokens?: number }).output_tokens ?? 0,
                },
              }
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
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        tools: toAnthropicTools(request.tools),
        max_tokens: request.maxTokens,
      }, { signal: request.abortSignal })

      return {
        content: fromAnthropicContent(response.content),
        stopReason: response.stop_reason as AICompletionResponse['stopReason'],
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      }
    },
  }
}

/**
 * Convert Studio messages to Anthropic format.
 */
function toAnthropicMessages(messages: AICompletionRequest['messages']): Anthropic.MessageParam[] {
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
        default:
          return { type: 'text' as const, text: '' }
      }
    })

    return { role: msg.role, content: blocks }
  })
}

/**
 * Convert Studio tools to Anthropic format.
 */
function toAnthropicTools(tools: AICompletionRequest['tools']): Anthropic.Tool[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
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
