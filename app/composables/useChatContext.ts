/**
 * Chat context chips — user-selected items sent as explicit context to the agent.
 *
 * Models, entries, and fields from the content panel can be pinned/dragged
 * to the context bar above the chat input. The agent sees these as
 * "pinned context" in its system prompt.
 */

export interface ContextChip {
  id: string
  type: 'model' | 'entry' | 'field'
  label: string
  sublabel?: string
  modelId: string
  modelName?: string
  entryId?: string
  fieldId?: string
  data?: unknown
}

/** Serialized context item sent to the server */
export interface ContextItem {
  type: 'model' | 'entry' | 'field'
  modelId: string
  modelName?: string
  entryId?: string
  fieldId?: string
  data?: unknown
}

const DRAG_MIME = 'application/x-context-chip'

function buildId(type: string, modelId: string, entryId?: string, fieldId?: string): string {
  return [type, modelId, entryId, fieldId].filter(Boolean).join(':')
}

export function useChatContext() {
  const chips = useState<ContextChip[]>('chat-context-chips', () => [])
  const isDragging = useState('chat-context-dragging', () => false)

  function add(chip: Omit<ContextChip, 'id'>) {
    const id = buildId(chip.type, chip.modelId, chip.entryId, chip.fieldId)
    if (chips.value.some(c => c.id === id)) return
    chips.value = [...chips.value, { ...chip, id }]
  }

  function remove(chipId: string) {
    chips.value = chips.value.filter(c => c.id !== chipId)
  }

  function toggle(chip: Omit<ContextChip, 'id'>) {
    const id = buildId(chip.type, chip.modelId, chip.entryId, chip.fieldId)
    if (chips.value.some(c => c.id === id)) {
      remove(id)
    }
    else {
      add(chip)
    }
  }

  function isPinned(type: string, modelId: string, entryId?: string, fieldId?: string): boolean {
    return chips.value.some(c => c.id === buildId(type, modelId, entryId, fieldId))
  }

  function clear() {
    chips.value = []
  }

  // Drag helpers
  function startDrag(e: DragEvent, chip: Omit<ContextChip, 'id'>) {
    if (!e.dataTransfer) return
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(chip))
    e.dataTransfer.effectAllowed = 'copy'
    isDragging.value = true
  }

  function endDrag() {
    isDragging.value = false
  }

  function handleDrop(e: DragEvent) {
    isDragging.value = false
    const raw = e.dataTransfer?.getData(DRAG_MIME)
    if (!raw) return
    try {
      const chip = JSON.parse(raw) as Omit<ContextChip, 'id'>
      add(chip)
    }
    catch { /* invalid data */ }
  }

  /** Convert chips to serializable context items for the API */
  function toContextItems(): ContextItem[] {
    return chips.value.map(({ type, modelId, modelName, entryId, fieldId, data }) => ({
      type,
      modelId,
      modelName,
      entryId,
      fieldId,
      data,
    }))
  }

  return {
    chips: readonly(chips),
    isDragging: readonly(isDragging),
    add,
    remove,
    toggle,
    isPinned,
    clear,
    startDrag,
    endDrag,
    handleDrop,
    toContextItems,
  }
}
