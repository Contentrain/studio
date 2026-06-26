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
  /**
   * Provider-agnostic prompt cache marker. When set on the LAST tool
   * in the array, supporting providers (Anthropic) cache the full
   * tools block. Unsupported providers ignore the field.
   */
  cacheControl?: AICacheControl
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string | AIContentBlock[]
}

export type AIContentBlock
  = | { type: 'text', text: string }
    | { type: 'tool_use', id: string, name: string, input: unknown }
    | { type: 'tool_result', toolUseId: string, content: string }
    | { type: 'image', source: AIImageSource }
    | { type: 'document', source: AIDocumentSource }

/**
 * Image attachment source. Provider-agnostic shape (camelCase
 * `mediaType`, consistent with `toolUseId`); the Anthropic adapter
 * maps it to `media_type`. Two source kinds:
 * - `url`: a publicly fetchable URL (e.g. a CDN delivery URL). Cheap —
 *   no base64 payload, replayable across turns.
 * - `base64`: inline bytes. Used as the no-CDN fallback; should be
 *   size-capped/downscaled before encoding.
 */
export type AIImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export type AIImageSource
  = | { type: 'base64', mediaType: AIImageMediaType, data: string }
    | { type: 'url', url: string }

/**
 * Document attachment source. PDF is the only natively-understood
 * document type on the Messages API; Word/Excel are converted to text
 * blocks upstream. Base64-only (the Messages API does not accept a URL
 * source for documents without the Files API).
 */
export interface AIDocumentSource {
  type: 'base64'
  mediaType: 'application/pdf'
  data: string
}

/**
 * Prompt cache marker. `ephemeral` is Anthropic's 5-minute TTL bucket.
 * Provider-agnostic shape — providers that don't support prompt
 * caching ignore the marker entirely and the request still works
 * (just without cache benefits).
 */
export interface AICacheControl {
  type: 'ephemeral'
}

/**
 * Structured system prompt block. Use the array form of
 * `AICompletionRequest.system` to place cache breakpoints between
 * blocks. A plain `string` is equivalent to a single uncached block
 * and stays accepted for backward compatibility.
 */
export interface AISystemBlock {
  type: 'text'
  text: string
  cacheControl?: AICacheControl
}

/**
 * Token usage on a single completion. Anthropic returns four disjoint
 * buckets — `input_tokens` semantic is "non-cached input only," so
 * the existing dashboards that sum it stay correct after this change.
 * Total billable input cost (Contentrain-side) is approximately:
 *   inputTokens * 1x + cacheCreationInputTokens * 1.25x + cacheReadInputTokens * 0.1x
 * at the base per-MTok price for the model.
 */
export interface AIUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

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
  usage?: AIUsage
  // error
  error?: string
}

export interface AICompletionRequest {
  model: string
  /**
   * String form is treated as a single uncached system block. Array
   * form lets callers place cache breakpoints between blocks; up to
   * 4 cache_control markers are honored per request (Anthropic
   * limit), shared across system + tools + messages.
   */
  system: string | AISystemBlock[]
  messages: AIMessage[]
  tools: AITool[]
  maxTokens: number
  abortSignal?: AbortSignal
}

export interface AICompletionResponse {
  content: AIContentBlock[]
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage: AIUsage
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
