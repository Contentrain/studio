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
      out.push({ kind: 'image', filename: 'image', previewUrl, mime: b.source.mediaType })
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
        ? readyAttachments.map(a => ({ kind: a.kind, filename: a.filename, previewUrl: a.previewUrl, mime: a.mime }))
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

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/chat`,
        {
          method: 'POST',
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
      const { t } = useContent()
      error.value = resolveApiError(e, t('chat.send_error'))
      // Remove empty assistant message on error
      if (!assistantMsg.text && assistantMsg.toolCalls.length === 0) {
        messages.value.pop()
      }
    }
    finally {
      isStreaming.value = false
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
        break
      }

      case 'done': {
        const affected = event.affected as AffectedResources | undefined
        if (affected && options?.onContentChanged) {
          options.onContentChanged(affected)
        }
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
    clearChat,
    fetchConversations,
    loadConversation,
    deleteConversation,
  }
}
