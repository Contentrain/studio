/**
 * Provider-agnostic AI interface.
 *
 * Abstracts AI model interaction for chat with tool use.
 * Current impl: Anthropic (server/providers/anthropic-ai.ts)
 * Future impls: OpenAI, Google Gemini, etc.
 *
 * Each provider must normalize their tool use format
 * to Studio's standard event stream.
 */

export interface AITool {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string | AIContentBlock[]
}

export type AIContentBlock
  = | { type: 'text', text: string }
    | { type: 'tool_use', id: string, name: string, input: unknown }
    | { type: 'tool_result', toolUseId: string, content: string }

export interface AIStreamEvent {
  type: 'text' | 'tool_use_start' | 'tool_use_input' | 'tool_use_end' | 'message_end' | 'error'
  // text
  content?: string
  // tool_use
  toolId?: string
  toolName?: string
  toolInput?: unknown
  // message_end
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'
  usage?: { inputTokens: number, outputTokens: number }
  // error
  error?: string
}

export interface AICompletionRequest {
  model: string
  system: string
  messages: AIMessage[]
  tools: AITool[]
  maxTokens: number
  abortSignal?: AbortSignal
}

export interface AICompletionResponse {
  content: AIContentBlock[]
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage: { inputTokens: number, outputTokens: number }
}

export interface AIProvider {
  /**
   * Send a completion request and get streaming events.
   * Yields AIStreamEvent objects for real-time UI updates.
   */
  streamCompletion: (
    request: AICompletionRequest,
    apiKey: string,
  ) => AsyncGenerator<AIStreamEvent>

  /**
   * Send a completion request and get the full response.
   * Used for tool loop continuation (non-streaming steps).
   */
  createCompletion: (
    request: AICompletionRequest,
    apiKey: string,
  ) => Promise<AICompletionResponse>
}
