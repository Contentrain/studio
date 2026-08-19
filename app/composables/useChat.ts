/**
 * Chat composable — manages SSE streaming, message state, tool calls,
 * conversation history, and model selection.
 */

import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from '~~/shared/utils/ai-models'

export interface ToolCall {
  id: string
  name: string
  input: unknown
  result?: unknown
  status: 'pending' | 'streaming' | 'complete' | 'error'
}

/**
 * One chronological slice of an assistant turn. A multi-iteration
 * agent turn interleaves narration and tool execution (text → tools →
 * text → tools…); segments preserve that order so the transcript reads
 * as a step-by-step record instead of one glued text wall with all
 * tool cards dumped at the end.
 */
export type MessageSegment
  = | { kind: 'text', text: string }
    | { kind: 'tool', call: ToolCall }

/** How an attachment renders in a message bubble. */
export interface MessageAttachment {
  kind: 'text' | 'document' | 'image'
  filename: string
  /** Image URL or a `data:` URL for base64 images. */
  previewUrl?: string
  mime?: string
  /** Where it landed: `media` (stored CDN asset) vs `context` (ephemeral). */
  destination?: 'context' | 'media'
}

/**
 * An attachment in the composer tray. `blocks` are the server-authored
 * `AIContentBlock[]` sent back in the chat body. `status` drives the
 * tray UI (spinner / ready / error).
 */
export interface UIAttachment {
  id: string
  status: 'uploading' | 'ready' | 'error'
  filename: string
  kind: 'text' | 'document' | 'image'
  mime: string
  /** Requested destination; confirmed by the server on success. */
  destination?: 'context' | 'media'
  /** Optimized/stored byte size, for the tray chip. */
  bytes?: number
  blocks?: unknown[]
  previewUrl?: string
  preview?: string
  truncated?: boolean
  error?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** Ordered narration/tool slices — see `MessageSegment`. */
  segments: MessageSegment[]
  createdAt: string
  /** Persisted turn id — used to fold same-turn assistant rows on load. */
  turnId?: string
  /** Context items attached to this message (user messages only) */
  contextItems?: Array<{
    type: 'model' | 'entry' | 'field' | 'asset'
    label: string
    sublabel?: string
  }>
  /** Files/links attached to this message (user messages only) */
  attachments?: MessageAttachment[]
}

/** Structural view accepted by the message helpers — also matches the
 * deep-readonly messages exposed by `useChat()`. */
interface MessageView {
  segments: readonly MessageSegment[]
  attachments?: readonly unknown[]
}

/** Concatenated text of a message's text segments. */
export function messageText(msg: MessageView): string {
  let out = ''
  for (const seg of msg.segments) {
    if (seg.kind === 'text') out += seg.text
  }
  return out
}

/** Whether a message has anything worth rendering (or keeping on error). */
export function hasVisibleContent(msg: MessageView): boolean {
  if (msg.attachments?.length) return true
  return msg.segments.some(seg => seg.kind === 'tool' || seg.text.trim().length > 0)
}

/** UI context sent with each message */
export interface ChatUIContext {
  activeModelId: string | null
  activeLocale: string
  activeEntryId: string | null
  panelState: 'overview' | 'model' | 'branch' | 'vocabulary'
  activeBranch: string | null
  /** Explicitly pinned context items from the content panel */
  contextItems?: Array<{
    type: 'model' | 'entry' | 'field'
    modelId: string
    modelName?: string
    entryId?: string
    fieldId?: string
    data?: unknown
  }>
}

/** Affected resources from tool execution */
export interface AffectedResources {
  models: string[]
  locales: string[]
  snapshotChanged: boolean
  branchesChanged: boolean
}

/** Conversation summary for history list */
export interface ConversationSummary {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

/** Available AI models — sourced from the shared catalog. */
export const AI_MODELS = CHAT_MODELS

/**
 * Reconstruct displayable attachments from a persisted user row's
 * `content_blocks`. Images → thumbnail (URL or base64 data URL),
 * documents → PDF chip, provenance-headed text blocks → file chip
 * (filename parsed from the `[Attached …: name]` header). The final
 * plain text block is the user's typed message (shown via `content`),
 * so it's skipped here.
 */
function hydrateAttachments(blocks: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(blocks)) return undefined
  const out: MessageAttachment[] = []
  for (const raw of blocks) {
    const b = raw as { type?: string, text?: string, source?: { type?: string, url?: string, mediaType?: string, data?: string } }
    if (b?.type === 'image' && b.source) {
      const previewUrl = b.source.type === 'url'
        ? b.source.url
        : (b.source.type === 'base64' ? `data:${b.source.mediaType};base64,${b.source.data}` : undefined)
      // A URL source is a stored media asset; base64 is ephemeral context.
      const destination = b.source.type === 'url' ? 'media' as const : 'context' as const
      out.push({ kind: 'image', filename: 'image', previewUrl, mime: b.source.mediaType, destination })
    }
    else if (b?.type === 'document') {
      out.push({ kind: 'document', filename: 'document.pdf', mime: b.source?.mediaType ?? 'application/pdf' })
    }
    else if (b?.type === 'text' && typeof b.text === 'string') {
      const m = b.text.match(/^\[Attached (?:file|spreadsheet|web page): (.+?)\]/)
      if (m) out.push({ kind: 'text', filename: m[1]! })
    }
  }
  return out.length ? out : undefined
}

/** A persisted transcript row as returned by the messages endpoint. */
interface ConversationRow {
  id: string
  role: string
  content: string
  content_blocks: unknown
  tool_calls: unknown
  created_at: string
  turn_id?: string | null
}

/**
 * Build ordered segments from a persisted assistant row.
 *
 * Priority: `content_blocks` (post-009 trace rows — the real
 * text/tool_use order Claude produced; the plain `content` column is a
 * text-only fallback that degrades to a literal `[tool calls]`
 * placeholder for tool-only iterations, so it must never render when
 * blocks exist) → legacy `tool_calls` wrapper (pre-trace rows) →
 * plain `content` text.
 */
function rowToSegments(row: ConversationRow): MessageSegment[] {
  if (Array.isArray(row.content_blocks) && row.content_blocks.length > 0) {
    const segments: MessageSegment[] = []
    for (const raw of row.content_blocks) {
      const b = raw as { type?: string, text?: string, id?: string, name?: string, input?: unknown }
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        segments.push({ kind: 'text', text: b.text })
      }
      else if (b?.type === 'tool_use' && b.id && b.name) {
        // Results live on internal tool_result rows that the transcript
        // endpoint doesn't return — the card renders name + input only.
        segments.push({ kind: 'tool', call: { id: b.id, name: b.name, input: b.input ?? null, status: 'complete' } })
      }
    }
    if (segments.length > 0) return segments
  }

  const segments: MessageSegment[] = []
  if (row.content.trim()) segments.push({ kind: 'text', text: row.content })
  if (Array.isArray(row.tool_calls)) {
    for (const raw of row.tool_calls as Array<{ id: string, name: string, input: unknown, result?: unknown }>) {
      if (!raw.name) continue
      segments.push({ kind: 'tool', call: { id: raw.id, name: raw.name, input: raw.input, result: raw.result, status: 'complete' } })
    }
  }
  return segments
}

const MODEL_KEY_PREFIX = 'contentrain-chat-model:'
const MODEL_KEY_LAST = 'contentrain-chat-model-last'

/**
 * Remember the picked model per project, so reopening a project resumes with
 * the model that project was last worked on. A project that has never been
 * opened starts from the model picked most recently anywhere, then the
 * catalog default.
 *
 * The scope comes from the route rather than a prop because the picker is not
 * the only writer — the command palette sets the model too, from outside the
 * chat panel.
 */
function useModelPersistence(selectedModel: Ref<string>) {
  if (!import.meta.client) return

  const route = useRoute()
  const projectId = computed(() => (route.params.projectId as string | undefined) ?? null)

  function read(id: string | null): string | null {
    const stored = (id && localStorage.getItem(MODEL_KEY_PREFIX + id)) || localStorage.getItem(MODEL_KEY_LAST)
    // A model that has left the catalog would keep showing a stale label: the
    // server quietly falls back to an allowed one (chat.post.ts), the picker
    // would not. Drop unknown ids instead of restoring them.
    return stored && CHAT_MODELS.some(m => m.id === stored) ? stored : null
  }

  function hydrate(id: string | null) {
    const stored = read(id)
    if (stored) selectedModel.value = stored
  }

  // Navigating between two projects reuses the page component, so the initial
  // read alone would leave the previous project's model selected.
  hydrate(projectId.value)
  watch(projectId, hydrate)

  watch(selectedModel, (model) => {
    localStorage.setItem(MODEL_KEY_LAST, model)
    if (projectId.value) localStorage.setItem(MODEL_KEY_PREFIX + projectId.value, model)
  })
}

export function useChat(options?: {
  onContentChanged?: (affected: AffectedResources) => void
}) {
  const messages = useState<ChatMessage[]>('chat-messages', () => [])
  const conversationId = useState<string | null>('chat-conversation-id', () => null)
  const conversations = useState<ConversationSummary[]>('chat-conversations', () => [])
  const isStreaming = useState('chat-streaming', () => false)
  const error = useState<string | null>('chat-error', () => null)
  const selectedModel = useState('chat-model', () => DEFAULT_CHAT_MODEL)
  useModelPersistence(selectedModel)
  // Monotonic counter bumped on every content-bearing SSE event. The
  // panel watches it for scroll-follow — cheaper than deep-watching the
  // whole message tree.
  const streamTick = useState('chat-stream-tick', () => 0)
  // Module-instance abort handle so the composer can stop a stream mid-flight.
  let abortController: AbortController | null = null

  function stopStreaming() {
    abortController?.abort()
  }

  // Live content-refresh debounce. Each content-mutating tool result
  // schedules a refresh; rapid bursts within a single turn coalesce into
  // one `onContentChanged` call so the context panel updates as the agent
  // works, instead of only after the whole turn finishes on `done`.
  const CONTENT_REFRESH_DEBOUNCE_MS = 500
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let pendingAffected: AffectedResources | null = null

  function blankAffected(): AffectedResources {
    return { models: [], locales: [], snapshotChanged: false, branchesChanged: false }
  }

  // Merge a tool's affected resources into the pending refresh batch.
  // Returns false (and skips scheduling) when nothing actually changed —
  // read-only tools carry an empty affected and must not trigger refetches.
  function accumulateAffected(src?: AffectedResources): boolean {
    if (!src) return false
    const hasChange = !!src.snapshotChanged || !!src.branchesChanged || (src.models?.length ?? 0) > 0
    if (!hasChange) return false
    const acc = (pendingAffected ??= blankAffected())
    for (const m of src.models ?? []) if (!acc.models.includes(m)) acc.models.push(m)
    for (const l of src.locales ?? []) if (!acc.locales.includes(l)) acc.locales.push(l)
    acc.snapshotChanged ||= !!src.snapshotChanged
    acc.branchesChanged ||= !!src.branchesChanged
    return true
  }

  function flushContentRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (pendingAffected && options?.onContentChanged) {
      options.onContentChanged(pendingAffected)
    }
    pendingAffected = null
  }

  function scheduleContentRefresh(src?: AffectedResources) {
    if (!accumulateAffected(src)) return
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(flushContentRefresh, CONTENT_REFRESH_DEBOUNCE_MS)
  }

  async function fetchConversations(workspaceId: string, projectId: string) {
    try {
      conversations.value = await $fetch<ConversationSummary[]>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/conversations`,
      )
    }
    catch {
      conversations.value = []
    }
  }

  async function loadConversation(workspaceId: string, projectId: string, convId: string) {
    try {
      const data = await $fetch<ConversationRow[]>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/conversations/${convId}/messages`,
      )

      // Convert DB messages to ChatMessage format. A turn persists one
      // assistant row PER iteration (all visible since the trace
      // visibility change) — consecutive assistant rows sharing a
      // turn_id fold into one message whose segments concatenate in
      // order, mirroring how the turn streamed live. The seed user row
      // shares the turn_id but user rows always start a new message, so
      // grouping stays assistant-only. Legacy rows carry distinct
      // turn_ids and degrade to one message per row.
      const grouped: ChatMessage[] = []
      for (const row of data) {
        if (row.role === 'user') {
          grouped.push({
            id: row.id,
            role: 'user',
            segments: row.content.trim() ? [{ kind: 'text', text: row.content }] : [],
            createdAt: row.created_at,
            attachments: hydrateAttachments(row.content_blocks),
          })
          continue
        }
        const prev = grouped[grouped.length - 1]
        if (prev && prev.role === 'assistant' && row.turn_id && prev.turnId === row.turn_id) {
          prev.segments.push(...rowToSegments(row))
          continue
        }
        grouped.push({
          id: row.id,
          role: 'assistant',
          segments: rowToSegments(row),
          createdAt: row.created_at,
          turnId: row.turn_id ?? undefined,
        })
      }
      messages.value = grouped

      conversationId.value = convId
    }
    catch {
      const { t } = useContent()
      error.value = t('chat.load_error')
    }
  }

  async function deleteConversation(workspaceId: string, projectId: string, convId: string) {
    try {
      await $fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/conversations/${convId}`, {
        method: 'DELETE',
      })
      conversations.value = conversations.value.filter(c => c.id !== convId)
      // If we deleted the active conversation, clear chat
      if (conversationId.value === convId) {
        clearChat()
      }
      return true
    }
    catch {
      return false
    }
  }

  async function sendMessage(
    workspaceId: string,
    projectId: string,
    text: string,
    context?: ChatUIContext,
    attachedChips?: Array<{ type: 'model' | 'entry' | 'field' | 'asset', label: string, sublabel?: string }>,
    attachments?: UIAttachment[],
  ) {
    if (!text.trim() || isStreaming.value) return

    error.value = null

    // Only ready attachments carry blocks; uploading/errored ones are ignored.
    const readyAttachments = (attachments ?? []).filter(a => a.status === 'ready' && a.blocks?.length)

    // Add user message with attached context + attachment previews
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      segments: [{ kind: 'text', text }],
      createdAt: new Date().toISOString(),
      contextItems: attachedChips?.length ? attachedChips : undefined,
      attachments: readyAttachments.length
        ? readyAttachments.map(a => ({ kind: a.kind, filename: a.filename, previewUrl: a.previewUrl, mime: a.mime, destination: a.destination }))
        : undefined,
    }
    messages.value.push(userMsg)

    // Create assistant placeholder
    messages.value.push({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      segments: [],
      createdAt: new Date().toISOString(),
    })
    // Mutate ONLY through the reactive proxy read back from the array.
    // Writing to the raw object captured before the push bypasses Vue's
    // proxies entirely — no effect ever fires, the message list never
    // re-renders mid-stream, and the whole turn pops in at once when
    // `isStreaming` flips at the end.
    const assistantMsg = messages.value[messages.value.length - 1]!

    isStreaming.value = true
    abortController = new AbortController()

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/chat`,
        {
          method: 'POST',
          signal: abortController.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            conversationId: conversationId.value,
            model: selectedModel.value,
            context: context ?? {
              activeModelId: null,
              activeLocale: 'en',
              activeEntryId: null,
              panelState: 'overview',
              activeBranch: null,
            },
            attachments: readyAttachments.length
              ? readyAttachments.map(a => ({ blocks: a.blocks, filename: a.filename, kind: a.kind }))
              : undefined,
          }),
        },
      )

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({})) as { message?: string, statusCode?: number }
        const status = errBody.statusCode ?? response.status
        // 4xx errors have user-friendly messages from backend; 5xx use fallback
        if (status >= 400 && status < 500 && errBody.message) {
          throw Object.assign(new Error(errBody.message), { statusCode: status })
        }
        throw Object.assign(new Error(`HTTP ${response.status}`), { statusCode: status })
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response stream')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE lines
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue

          try {
            const event = JSON.parse(data)
            handleSSEEvent(event, assistantMsg)
          }
          catch {
            // Skip malformed JSON
          }
        }
      }

      // After successful send, refresh conversation list
      fetchConversations(workspaceId, projectId)
    }
    catch (e: unknown) {
      // User-initiated stop: keep whatever already streamed, no error toast.
      if ((e as Error)?.name === 'AbortError') {
        if (!hasVisibleContent(assistantMsg)) {
          messages.value.pop()
        }
      }
      else {
        const { t } = useContent()
        error.value = resolveApiError(e, t('chat.send_error'))
        // Remove empty assistant message on error
        if (!hasVisibleContent(assistantMsg)) {
          messages.value.pop()
        }
      }
    }
    finally {
      isStreaming.value = false
      abortController = null
      // If the stream ended/aborted/errored before a `done`, still reflect
      // any content the agent already changed mid-turn (no-op if `done`
      // already flushed).
      flushContentRefresh()
    }
  }

  /** Latest tool segment matching an id — searched from the end because
   * tool ids are unique per turn and live updates always target the
   * most recent calls. */
  function findToolCall(msg: ChatMessage, id: unknown): ToolCall | undefined {
    for (let i = msg.segments.length - 1; i >= 0; i--) {
      const seg = msg.segments[i]!
      if (seg.kind === 'tool' && seg.call.id === id) return seg.call
    }
    return undefined
  }

  function handleSSEEvent(event: Record<string, unknown>, msg: ChatMessage) {
    switch (event.type) {
      case 'conversation':
        conversationId.value = event.id as string
        break

      case 'text': {
        const last = msg.segments[msg.segments.length - 1]
        if (last?.kind === 'text') last.text += event.content as string
        else msg.segments.push({ kind: 'text', text: event.content as string })
        streamTick.value++
        break
      }

      case 'tool_use':
        msg.segments.push({
          kind: 'tool',
          call: {
            id: event.id as string,
            name: event.name as string,
            input: null,
            status: 'pending',
          },
        })
        streamTick.value++
        break

      case 'tool_input': {
        // Input arrives when the model finishes emitting the call —
        // before the (potentially long) execution — so the card shows
        // what's being done while it's pending.
        const tc = findToolCall(msg, event.id)
        if (tc) tc.input = event.input ?? null
        streamTick.value++
        break
      }

      case 'tool_result': {
        const tc = findToolCall(msg, event.id)
        if (tc) {
          tc.result = event.result
          if (event.input !== undefined && tc.input == null) tc.input = event.input
          tc.status = 'complete'
        }
        // Live refresh: reflect this operation in the context panel without
        // waiting for the whole turn to finish (debounced + coalesced).
        scheduleContentRefresh(event.affected as AffectedResources | undefined)
        streamTick.value++
        break
      }

      case 'done': {
        // Turn finished — supersede any pending debounced preview with one
        // authoritative refresh covering everything the turn touched.
        accumulateAffected(event.affected as AffectedResources | undefined)
        flushContentRefresh()
        break
      }

      case 'error': {
        const { t } = useContent()
        // Output-token truncation is a distinct, actionable failure: the
        // turn was cut off before a pending save/create ran. Give it its
        // own localized message instead of the generic send failure. Any
        // partial text already streamed stays in the bubble.
        error.value = event.code === 'output_truncated'
          ? t('chat.output_truncated')
          // Other SSE error events may carry raw backend messages — use fallback
          : t('chat.send_error')
        streamTick.value++
        break
      }
    }
  }

  function clearChat() {
    messages.value = []
    conversationId.value = null
    error.value = null
  }

  return {
    messages: readonly(messages),
    conversationId: readonly(conversationId),
    conversations: readonly(conversations),
    isStreaming: readonly(isStreaming),
    error: readonly(error),
    streamTick: readonly(streamTick),
    selectedModel,
    sendMessage,
    stopStreaming,
    clearChat,
    fetchConversations,
    loadConversation,
    deleteConversation,
  }
}
