import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat } from '../../../app/composables/useChat'

function createStreamResponse(chunks: string[]) {
  let index = 0

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) {
              return { done: true, value: undefined }
            }
            const chunk = new TextEncoder().encode(chunks[index])
            index++
            return { done: false, value: chunk }
          },
        }
      },
    },
  }
}

describe('useChat', () => {
  beforeEach(() => {
    useState('chat-messages').value = []
    useState('chat-conversation-id').value = null
    useState('chat-conversations').value = []
    useState('chat-streaming').value = false
    useState('chat-error').value = null
    useState('chat-model').value = 'claude-sonnet-4-20250514'
  })

  it('loads existing conversations and maps tool calls into chat messages', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([
      {
        id: 'message-1',
        role: 'assistant',
        content: 'Saved successfully',
        tool_calls: [{ id: 'tool-1', name: 'save_content', input: { model: 'faq' }, result: { ok: true } }],
        created_at: '2026-03-25T00:00:00.000Z',
      },
    ]))

    const chat = useChat()
    await chat.loadConversation('workspace-1', 'project-1', 'conv-1')

    expect(chat.conversationId.value).toBe('conv-1')
    expect(chat.messages.value[0]).toMatchObject({
      id: 'message-1',
      role: 'assistant',
      text: 'Saved successfully',
    })
    expect(chat.messages.value[0]?.toolCalls[0]).toMatchObject({
      id: 'tool-1',
      name: 'save_content',
      status: 'complete',
    })
  })

  it('streams assistant text, tool results, and affected resources from sse', async () => {
    const onContentChanged = vi.fn()
    const fetchConversations = vi.fn().mockResolvedValue([])
    vi.stubGlobal('$fetch', fetchConversations)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"conversation","id":"conv-1"}\n',
      'data: {"type":"text","content":"Merhaba"}\n',
      'data: {"type":"tool_use","id":"tool-1","name":"save_content"}\n',
      'data: {"type":"tool_result","id":"tool-1","result":{"branch":"cr/content/faq/tr/1234567890-abcd"}}\n',
      'data: {"type":"done","affected":{"models":["faq"],"locales":["tr"],"snapshotChanged":false,"branchesChanged":true}}\n',
    ])))

    const chat = useChat({ onContentChanged })
    await chat.sendMessage('workspace-1', 'project-1', 'FAQ kaydet')

    expect(chat.conversationId.value).toBe('conv-1')
    expect(chat.messages.value).toHaveLength(2)
    expect(chat.messages.value[0]?.text).toBe('FAQ kaydet')
    expect(chat.messages.value[1]?.text).toBe('Merhaba')
    expect(chat.messages.value[1]?.toolCalls[0]).toMatchObject({
      id: 'tool-1',
      name: 'save_content',
      result: { branch: 'cr/content/faq/tr/1234567890-abcd' },
      status: 'complete',
    })
    expect(onContentChanged).toHaveBeenCalledWith({
      models: ['faq'],
      locales: ['tr'],
      snapshotChanged: false,
      branchesChanged: true,
    })
  })

  it('removes the empty assistant placeholder when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failed')))

    const chat = useChat()
    await chat.sendMessage('workspace-1', 'project-1', 'Test')

    expect(chat.messages.value).toHaveLength(1)
    expect(chat.messages.value[0]?.role).toBe('user')
    expect(chat.error.value).toBe('Network failed')
  })
})
