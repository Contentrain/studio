/**
 * Chat composable — manages SSE streaming, message state, tool calls,
 * conversation history, and model selection.
 */

export interface ToolCall {
  id: string
  name: string
  input: unknown
  result?: unknown
  status: 'pending' | 'streaming' | 'complete' | 'error'
}

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
  text: string
  toolCalls: ToolCall[]
  createdAt: string
  /** Context items attached to this message (user messages only) */
  contextItems?: Array<{
    type: 'model' | 'entry' | 'field' | 'asset'
    label: string
    sublabel?: string
  }>
  /** Files/links attached to this message (user messages only) */
  attachments?: MessageAttachment[]
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

/** Available AI models */
export const AI_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fast & economic' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Balanced' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Most capable' },
] as const

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

export function useChat(options?: {
  onContentChanged?: (affected: AffectedResources) => void
}) {
  const messages = useState<ChatMessage[]>('chat-messages', () => [])
  const conversationId = useState<string | null>('chat-conversation-id', () => null)
  const conversations = useState<ConversationSummary[]>('chat-conversations', () => [])
  const isStreaming = useState('chat-streaming', () => false)
  const error = useState<string | null>('chat-error', () => null)
  const selectedModel = useState('chat-model', () => 'claude-sonnet-4-6')
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
      const data = await $fetch<Array<{
        id: string
        role: string
        content: string
        content_blocks: unknown
        tool_calls: unknown
        created_at: string
      }>>(`/api/workspaces/${workspaceId}/projects/${projectId}/conversations/${convId}/messages`)

      // Convert DB messages to ChatMessage format
      messages.value = data.map(row => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        text: row.content,
        toolCalls: Array.isArray(row.tool_calls)
          ? (row.tool_calls as Array<{ id: string, name: string, input: unknown, result?: unknown }>).filter(b => b.name).map(b => ({
              id: b.id,
              name: b.name,
              input: b.input,
              result: b.result,
              status: 'complete' as const,
            }))
          : [],
        createdAt: row.created_at,
        attachments: row.role === 'user' ? hydrateAttachments(row.content_blocks) : undefined,
      }))

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
      text,
      toolCalls: [],
      createdAt: new Date().toISOString(),
      contextItems: attachedChips?.length ? attachedChips : undefined,
      attachments: readyAttachments.length
        ? readyAttachments.map(a => ({ kind: a.kind, filename: a.filename, previewUrl: a.previewUrl, mime: a.mime, destination: a.destination }))
        : undefined,
    }
    messages.value.push(userMsg)

    // Create assistant placeholder
    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      text: '',
      toolCalls: [],
      createdAt: new Date().toISOString(),
    }
    messages.value.push(assistantMsg)

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
        if (!assistantMsg.text && assistantMsg.toolCalls.length === 0) {
          messages.value.pop()
        }
      }
      else {
        const { t } = useContent()
        error.value = resolveApiError(e, t('chat.send_error'))
        // Remove empty assistant message on error
        if (!assistantMsg.text && assistantMsg.toolCalls.length === 0) {
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

  function handleSSEEvent(event: Record<string, unknown>, msg: ChatMessage) {
    switch (event.type) {
      case 'conversation':
        conversationId.value = event.id as string
        break

      case 'text':
        msg.text += event.content as string
        break

      case 'tool_use':
        msg.toolCalls.push({
          id: event.id as string,
          name: event.name as string,
          input: null,
          status: 'pending',
        })
        break

      case 'tool_result': {
        const tc = msg.toolCalls.find(t => t.id === event.id)
        if (tc) {
          tc.result = event.result
          tc.status = 'complete'
        }
        // Live refresh: reflect this operation in the context panel without
        // waiting for the whole turn to finish (debounced + coalesced).
        scheduleContentRefresh(event.affected as AffectedResources | undefined)
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
        // SSE error events may contain raw backend messages — use fallback
        error.value = t('chat.send_error')
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
    selectedModel,
    sendMessage,
    stopStreaming,
    clearChat,
    fetchConversations,
    loadConversation,
    deleteConversation,
  }
}
