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

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  toolCalls: ToolCall[]
  createdAt: string
  /** Context items attached to this message (user messages only) */
  contextItems?: Array<{
    type: 'model' | 'entry' | 'field'
    label: string
    sublabel?: string
  }>
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
  { id: 'claude-sonnet-4-20250514', label: 'Sonnet 4', description: 'Balanced' },
  { id: 'claude-opus-4-20250514', label: 'Opus 4', description: 'Most capable' },
] as const

export function useChat(options?: {
  onContentChanged?: (affected: AffectedResources) => void
}) {
  const messages = useState<ChatMessage[]>('chat-messages', () => [])
  const conversationId = useState<string | null>('chat-conversation-id', () => null)
  const conversations = useState<ConversationSummary[]>('chat-conversations', () => [])
  const isStreaming = useState('chat-streaming', () => false)
  const error = useState<string | null>('chat-error', () => null)
  const selectedModel = useState('chat-model', () => 'claude-sonnet-4-20250514')

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
      }))

      conversationId.value = convId
    }
    catch {
      error.value = 'Failed to load conversation'
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
    attachedChips?: Array<{ type: 'model' | 'entry' | 'field', label: string, sublabel?: string }>,
  ) {
    if (!text.trim() || isStreaming.value) return

    error.value = null

    // Add user message with attached context
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text,
      toolCalls: [],
      createdAt: new Date().toISOString(),
      contextItems: attachedChips?.length ? attachedChips : undefined,
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
          }),
        },
      )

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}))
        throw new Error((errBody as { message?: string }).message ?? `HTTP ${response.status}`)
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
      error.value = e instanceof Error ? e.message : 'Chat failed'
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

      case 'error':
        error.value = event.message as string
        break
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
