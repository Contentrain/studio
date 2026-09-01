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

/**
 * Message content block. Every variant accepts an optional `cacheControl`
 * marker: `conversation-history.ts` places one on the last block of the
 * newest replayed history message so the whole conversation prefix is
 * served from the prompt cache instead of being re-billed every call.
 */
export type AIContentBlock = AIContentBlockBase & { cacheControl?: AICacheControl }

type AIContentBlockBase
  = | { type: 'text', text: string }
    | { type: 'tool_use', id: string, name: string, input: unknown }
    | { type: 'tool_result', toolUseId: string, content: string, isError?: boolean }
    | { type: 'image', source: AIImageSource }
    | { type: 'document', source: AIDocumentSource }

/**
 * Image attachment source. Provider-agnostic shape (camelCase
 * `mediaType`, consistent with `toolUseId`); the Anthropic adapter
 * maps it to `media_type`. Two source kinds:
 * - `url`: a publicly fetchable URL (e.g. a CDN delivery URL). No base64
 *   payload in the request, but NOT free: the provider fetches it and
 *   bills it by pixel count exactly like an inline image, so history
 *   replay must not repeat it turn after turn (see
 *   `stripHistoricalImages` in `conversation-history.ts`).
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
 * Prompt cache marker. Provider-agnostic shape — providers that don't
 * support prompt caching ignore the marker entirely and the request
 * still works (just without cache benefits).
 */
export interface AICacheControl {
  type: 'ephemeral'
  /**
   * Cache lifetime. Anthropic: `5m` (default; write costs 1.25× base
   * input) or `1h` (write costs 2× base input). A cache read refreshes
   * the timer at no cost on either TTL. Anthropic requires longer-TTL
   * markers to appear BEFORE shorter ones in the prompt, so every
   * marker Studio places uses the same value — `PROMPT_CACHE_CONTROL`.
   */
  ttl?: '5m' | '1h'
}

/**
 * The one cache policy for every marker Studio places (tools, static
 * system body, replayed-history tail).
 *
 * 1h rather than the 5m default: editorial sessions are bursty — an
 * editor writes for a few minutes, reviews the result on the site,
 * comes back ten minutes later. With 5m every such pause re-wrote the
 * entire history at 1.25×; with 1h the prefix survives the pause and
 * only the per-turn delta is written (at 2×, on a few thousand
 * tokens). Measured on a real 48-turn session: 13 pauses over 5
 * minutes, 2 over an hour.
 */
export const PROMPT_CACHE_CONTROL: AICacheControl = { type: 'ephemeral', ttl: '1h' }

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
 *   inputTokens * 1x + cacheCreationInputTokens * 2x + cacheReadInputTokens * 0.1x
 * at the base per-MTok price for the model (cache writes are 2× under
 * the 1h TTL Studio uses — see `PROMPT_CACHE_CONTROL`; 1.25× under 5m).
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
