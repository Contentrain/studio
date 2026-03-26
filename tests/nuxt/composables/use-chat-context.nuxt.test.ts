import { beforeEach, describe, expect, it } from 'vitest'
import { useChatContext } from '../../../app/composables/useChatContext'

describe('useChatContext', () => {
  beforeEach(() => {
    useState('chat-context-chips').value = []
    useState('chat-context-dragging').value = false
  })

  it('adds unique chips and toggles them by identity', () => {
    const ctx = useChatContext()

    ctx.add({
      type: 'entry',
      label: 'Homepage',
      modelId: 'pages',
      entryId: 'home',
    })
    ctx.add({
      type: 'entry',
      label: 'Homepage',
      modelId: 'pages',
      entryId: 'home',
    })

    expect(ctx.chips.value).toHaveLength(1)
    expect(ctx.isPinned('entry', 'pages', 'home')).toBe(true)

    ctx.toggle({
      type: 'entry',
      label: 'Homepage',
      modelId: 'pages',
      entryId: 'home',
    })

    expect(ctx.chips.value).toHaveLength(0)
  })

  it('handles drag-drop payloads and serializes api context items', () => {
    const ctx = useChatContext()
    const payload = {
      type: 'field' as const,
      label: 'Title',
      sublabel: 'Hero section',
      modelId: 'hero',
      modelName: 'Hero',
      entryId: 'homepage',
      fieldId: 'title',
      data: { value: 'Hello' },
    }

    const event = {
      dataTransfer: {
        getData: () => JSON.stringify(payload),
        setData: () => {},
        effectAllowed: 'copy',
      },
    } as unknown as DragEvent

    ctx.startDrag(event, payload)
    ctx.handleDrop(event)

    expect(ctx.isDragging.value).toBe(false)
    expect(ctx.chips.value[0]).toMatchObject({
      type: 'field',
      modelId: 'hero',
      fieldId: 'title',
    })
    expect(ctx.toContextItems()).toEqual([
      {
        type: 'field',
        modelId: 'hero',
        modelName: 'Hero',
        entryId: 'homepage',
        fieldId: 'title',
        data: { value: 'Hello' },
      },
    ])
  })
})
