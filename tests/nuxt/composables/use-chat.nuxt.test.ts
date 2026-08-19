import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, watch } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { messageText, useChat } from '../../../app/composables/useChat'
import { DEFAULT_CHAT_MODEL } from '../../../shared/utils/ai-models'

// The model scope comes from the route, so the persistence tests need to move
// between projects. Hoisted because mockNuxtImport's factory is lifted above
// the imports.
const { route } = vi.hoisted(() => ({ route: { params: {} as { projectId?: string } } }))
mockNuxtImport('useRoute', () => () => route)

function createStreamResponse(chunks: string[], options?: { failAfter?: Error }) {
  let index = 0

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) {
              if (options?.failAfter) throw options.failAfter
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
  beforeEach(async () => {
    useState('chat-messages').value = []
    useState('chat-conversation-id').value = null
    useState('chat-conversations').value = []
    useState('chat-streaming').value = false
    useState('chat-error').value = null
    useState('chat-model').value = DEFAULT_CHAT_MODEL
    useState('chat-stream-tick').value = 0
    route.params = {}
    // Persistence watchers registered by an earlier useChat() call outlive
    // their test — there is no component scope to stop them. Let their writes
    // land before clearing, so each test starts from empty storage.
    await nextTick()
    localStorage.clear()
  })

  it('loads legacy conversations and maps tool_calls into tool segments', async () => {
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
    const msg = chat.messages.value[0]!
    expect(msg).toMatchObject({ id: 'message-1', role: 'assistant' })
    expect(msg.segments).toHaveLength(2)
    expect(msg.segments[0]).toEqual({ kind: 'text', text: 'Saved successfully' })
    expect(msg.segments[1]).toMatchObject({
      kind: 'tool',
      call: { id: 'tool-1', name: 'save_content', status: 'complete' },
    })
  })

  it('hydrates segments from content_blocks and never renders the [tool calls] placeholder', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([
      {
        id: 'message-1',
        role: 'assistant',
        // Tool-only iteration: content column carries the placeholder,
        // content_blocks carries the real trace.
        content: '[tool calls]',
        content_blocks: [
          { type: 'text', text: 'Şimdi kaydediyorum.' },
          { type: 'tool_use', id: 'tool-1', name: 'save_content', input: { model: 'faq' } },
        ],
        tool_calls: null,
        created_at: '2026-03-25T00:00:00.000Z',
      },
    ]))

    const chat = useChat()
    await chat.loadConversation('workspace-1', 'project-1', 'conv-1')

    const msg = chat.messages.value[0]!
    expect(msg.segments).toHaveLength(2)
    expect(msg.segments[0]).toEqual({ kind: 'text', text: 'Şimdi kaydediyorum.' })
    expect(msg.segments[1]).toMatchObject({
      kind: 'tool',
      call: { id: 'tool-1', name: 'save_content', input: { model: 'faq' }, status: 'complete' },
    })
    expect(messageText(msg)).not.toContain('[tool calls]')
  })

  it('folds same-turn assistant rows into one message with concatenated segments', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([
      { id: 'r1', role: 'user', content: 'Makaleleri ekle', turn_id: 'turn-1', created_at: '2026-03-25T00:00:00.000Z' },
      {
        id: 'r2',
        role: 'assistant',
        content: 'Şimdi kaydediyorum.',
        content_blocks: [
          { type: 'text', text: 'Şimdi kaydediyorum.' },
          { type: 'tool_use', id: 't1', name: 'save_content', input: { locale: 'tr' } },
        ],
        turn_id: 'turn-1',
        created_at: '2026-03-25T00:00:01.000Z',
      },
      {
        id: 'r3',
        role: 'assistant',
        content: 'Tamamlandı.',
        content_blocks: [{ type: 'text', text: 'Tamamlandı.' }],
        turn_id: 'turn-1',
        created_at: '2026-03-25T00:00:02.000Z',
      },
      // Next turn: the user row breaks the fold even before turn_id changes.
      { id: 'r4', role: 'user', content: 'Teşekkürler', turn_id: 'turn-2', created_at: '2026-03-25T00:01:00.000Z' },
      {
        id: 'r5',
        role: 'assistant',
        content: 'Rica ederim.',
        content_blocks: [{ type: 'text', text: 'Rica ederim.' }],
        turn_id: 'turn-2',
        created_at: '2026-03-25T00:01:01.000Z',
      },
    ]))

    const chat = useChat()
    await chat.loadConversation('workspace-1', 'project-1', 'conv-1')

    expect(chat.messages.value).toHaveLength(4)
    const turn1 = chat.messages.value[1]!
    expect(turn1.id).toBe('r2')
    expect(turn1.segments.map(s => s.kind)).toEqual(['text', 'tool', 'text'])
    expect(turn1.segments[2]).toEqual({ kind: 'text', text: 'Tamamlandı.' })
    expect(chat.messages.value[2]?.role).toBe('user')
    expect(chat.messages.value[3]?.id).toBe('r5')
  })

  it('keeps legacy rows with distinct turn ids as separate messages', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([
      { id: 'r1', role: 'assistant', content: 'First reply', turn_id: 'legacy-1', created_at: '2026-03-25T00:00:00.000Z' },
      { id: 'r2', role: 'assistant', content: 'Second reply', turn_id: 'legacy-2', created_at: '2026-03-25T00:00:01.000Z' },
    ]))

    const chat = useChat()
    await chat.loadConversation('workspace-1', 'project-1', 'conv-1')

    expect(chat.messages.value).toHaveLength(2)
    expect(messageText(chat.messages.value[0]!)).toBe('First reply')
    expect(messageText(chat.messages.value[1]!)).toBe('Second reply')
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
    expect(messageText(chat.messages.value[0]!)).toBe('FAQ kaydet')
    const assistant = chat.messages.value[1]!
    expect(assistant.segments[0]).toEqual({ kind: 'text', text: 'Merhaba' })
    expect(assistant.segments[1]).toMatchObject({
      kind: 'tool',
      call: {
        id: 'tool-1',
        name: 'save_content',
        result: { branch: 'cr/content/faq/tr/1234567890-abcd' },
        status: 'complete',
      },
    })
    expect(onContentChanged).toHaveBeenCalledWith({
      models: ['faq'],
      locales: ['tr'],
      snapshotChanged: false,
      branchesChanged: true,
    })
  })

  it('keeps narration and tool calls in chronological segments across iterations', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"text","content":"TR içeriğini kaydediyorum."}\n',
      'data: {"type":"tool_use","id":"t1","name":"save_content"}\n',
      'data: {"type":"tool_result","id":"t1","result":{"ok":true}}\n',
      'data: {"type":"text","content":"Şimdi EN lokali."}\n',
      'data: {"type":"tool_use","id":"t2","name":"save_content"}\n',
      'data: {"type":"tool_result","id":"t2","result":{"ok":true}}\n',
      'data: {"type":"text","content":"Bitti."}\n',
      'data: {"type":"done","affected":{"models":[],"locales":[],"snapshotChanged":false,"branchesChanged":false}}\n',
    ])))

    const chat = useChat()
    await chat.sendMessage('workspace-1', 'project-1', 'iki lokale kaydet')

    const assistant = chat.messages.value[1]!
    expect(assistant.segments.map(s => s.kind)).toEqual(['text', 'tool', 'text', 'tool', 'text'])
    // Iteration texts stay separate segments — not glued into one wall.
    expect(assistant.segments[0]).toEqual({ kind: 'text', text: 'TR içeriğini kaydediyorum.' })
    expect(assistant.segments[2]).toEqual({ kind: 'text', text: 'Şimdi EN lokali.' })
    expect(assistant.segments[4]).toEqual({ kind: 'text', text: 'Bitti.' })
  })

  it('populates tool input from tool_input events before the result arrives', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"tool_use","id":"t1","name":"save_content"}\n',
      'data: {"type":"tool_input","id":"t1","input":{"model":"faq","locale":"tr"}}\n',
    ])))

    const chat = useChat()
    await chat.sendMessage('workspace-1', 'project-1', 'FAQ kaydet')

    const assistant = chat.messages.value[1]!
    expect(assistant.segments[0]).toMatchObject({
      kind: 'tool',
      call: { id: 't1', input: { model: 'faq', locale: 'tr' }, status: 'pending' },
    })
  })

  it('backfills tool input from the tool_result event without clobbering an existing value', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"tool_use","id":"t1","name":"save_content"}\n',
      'data: {"type":"tool_result","id":"t1","input":{"model":"faq"},"result":{"ok":true}}\n',
      'data: {"type":"tool_use","id":"t2","name":"brain_query"}\n',
      'data: {"type":"tool_input","id":"t2","input":{"model":"faq","entryId":"e1"}}\n',
      'data: {"type":"tool_result","id":"t2","result":{"data":null}}\n',
    ])))

    const chat = useChat()
    await chat.sendMessage('workspace-1', 'project-1', 'FAQ kaydet')

    const assistant = chat.messages.value[1]!
    expect(assistant.segments[0]).toMatchObject({
      kind: 'tool',
      call: { id: 't1', input: { model: 'faq' }, status: 'complete' },
    })
    // t2's input came via tool_input; the input-less result must not erase it.
    expect(assistant.segments[1]).toMatchObject({
      kind: 'tool',
      call: { id: 't2', input: { model: 'faq', entryId: 'e1' }, status: 'complete' },
    })
  })

  it('mutates the assistant message through the reactive proxy so the UI re-renders mid-stream', async () => {
    // Regression: the SSE reducer used to mutate the RAW placeholder
    // object captured before `messages.value.push(...)`. Raw-target
    // mutations bypass Vue's proxies, so the message list never
    // re-rendered during a stream — the whole turn appeared at once
    // when `isStreaming` flipped at the end. A sync-flush watcher on
    // the proxied message must fire for every content event.
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"text","content":"Başlıyorum."}\n',
      'data: {"type":"tool_use","id":"t1","name":"save_content"}\n',
      'data: {"type":"tool_result","id":"t1","result":{"ok":true}}\n',
      'data: {"type":"text","content":"Bitti."}\n',
    ])))

    const chat = useChat()
    let updates = 0
    const stop = watch(
      () => {
        const msg = chat.messages.value[1]
        if (!msg) return ''
        return `${msg.segments.length}:${messageText(msg)}:${msg.segments.filter(s => s.kind === 'tool' && s.call.status === 'complete').length}`
      },
      () => { updates++ },
      { flush: 'sync' },
    )
    await chat.sendMessage('workspace-1', 'project-1', 'makale yaz')
    stop()

    // placeholder append + text + tool_use + tool_result + closing text
    expect(updates).toBeGreaterThanOrEqual(4)
    expect(chat.messages.value[1]?.segments.map(s => s.kind)).toEqual(['text', 'tool', 'text'])
  })

  it('keeps partially streamed content when the user aborts mid-turn', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"text","content":"Başladım…"}\n',
    ], { failAfter: abortError })))

    const chat = useChat()
    await chat.sendMessage('workspace-1', 'project-1', 'uzun iş')

    expect(chat.messages.value).toHaveLength(2)
    expect(messageText(chat.messages.value[1]!)).toBe('Başladım…')
    expect(chat.error.value).toBeNull()
  })

  it('bumps streamTick on content-bearing sse events', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"conversation","id":"conv-1"}\n',
      'data: {"type":"text","content":"a"}\n',
      'data: {"type":"tool_use","id":"t1","name":"save_content"}\n',
      'data: {"type":"tool_input","id":"t1","input":{}}\n',
      'data: {"type":"tool_result","id":"t1","result":{"ok":true}}\n',
      'data: {"type":"done","affected":{"models":[],"locales":[],"snapshotChanged":false,"branchesChanged":false}}\n',
    ])))

    const chat = useChat()
    await chat.sendMessage('workspace-1', 'project-1', 'test')

    // conversation + done don't move content — 4 content events tick.
    expect(chat.streamTick.value).toBe(4)
  })

  it('refreshes content from a tool result even when the stream ends without a done event', async () => {
    // A content-mutating tool result carries `affected`; the context panel
    // must refresh from it (debounced, flushed when the stream ends) instead
    // of only on `done`. Here the stream ends with no `done` — the finally
    // flush still fires the refresh so mid-turn progress is reflected.
    const onContentChanged = vi.fn()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"tool_use","id":"t1","name":"save_content"}\n',
      'data: {"type":"tool_result","id":"t1","result":{"ok":true},"affected":{"models":["faq"],"locales":["tr"],"snapshotChanged":false,"branchesChanged":true}}\n',
    ])))

    const chat = useChat({ onContentChanged })
    await chat.sendMessage('workspace-1', 'project-1', 'FAQ kaydet')

    expect(onContentChanged).toHaveBeenCalledTimes(1)
    expect(onContentChanged).toHaveBeenCalledWith({
      models: ['faq'],
      locales: ['tr'],
      snapshotChanged: false,
      branchesChanged: true,
    })
  })

  it('ignores read-only tool results that carry no content changes', async () => {
    const onContentChanged = vi.fn()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"tool_use","id":"t1","name":"brain_query"}\n',
      'data: {"type":"tool_result","id":"t1","result":{"data":[]},"affected":{"models":[],"locales":[],"snapshotChanged":false,"branchesChanged":false}}\n',
      'data: {"type":"done","affected":{"models":[],"locales":[],"snapshotChanged":false,"branchesChanged":false}}\n',
    ])))

    const chat = useChat({ onContentChanged })
    await chat.sendMessage('workspace-1', 'project-1', 'list faq')

    expect(onContentChanged).not.toHaveBeenCalled()
  })

  it('removes the empty assistant placeholder when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failed')))

    const chat = useChat()
    await chat.sendMessage('workspace-1', 'project-1', 'Test')

    expect(chat.messages.value).toHaveLength(1)
    expect(chat.messages.value[0]?.role).toBe('user')
    // Network error without statusCode → resolveApiError returns user-friendly fallback
    expect(chat.error.value).not.toBe('Network failed')
    expect(chat.error.value).toBeTruthy()
  })

  describe('model persistence', () => {
    const OPUS = 'claude-opus-4-8'
    const HAIKU = 'claude-haiku-4-5-20251001'

    it('stores the picked model against the open project', async () => {
      route.params = { projectId: 'project-a' }
      const chat = useChat()

      chat.selectedModel.value = OPUS
      await nextTick()

      expect(localStorage.getItem('contentrain-chat-model:project-a')).toBe(OPUS)
      expect(localStorage.getItem('contentrain-chat-model-last')).toBe(OPUS)
    })

    it('resumes each project with the model it was last worked on', () => {
      localStorage.setItem('contentrain-chat-model:project-a', OPUS)
      localStorage.setItem('contentrain-chat-model:project-b', HAIKU)

      route.params = { projectId: 'project-a' }
      expect(useChat().selectedModel.value).toBe(OPUS)

      route.params = { projectId: 'project-b' }
      expect(useChat().selectedModel.value).toBe(HAIKU)
    })

    it('opens a never-visited project with the model picked most recently anywhere', () => {
      localStorage.setItem('contentrain-chat-model-last', OPUS)

      route.params = { projectId: 'first-visit' }

      expect(useChat().selectedModel.value).toBe(OPUS)
    })

    it('ignores a stored model that has left the catalog', () => {
      // The server quietly falls back to an allowed model; the picker would
      // otherwise keep showing a label for a model nobody can select.
      localStorage.setItem('contentrain-chat-model:project-a', 'claude-sonnet-4-0')

      route.params = { projectId: 'project-a' }

      expect(useChat().selectedModel.value).toBe(DEFAULT_CHAT_MODEL)
    })
  })
})
