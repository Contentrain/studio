<script setup lang="ts">
/**
 * Context bar — shows pinned context chips above the chat input.
 * Also serves as a drop zone for drag-and-drop from the content panel.
 */
const { t } = useContent()
const { chips, isDragging, remove, clear, handleDrop } = useChatContext()

const isDragOver = ref(false)

function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('application/x-context-chip')) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    isDragOver.value = true
  }
}

function onDragLeave() {
  isDragOver.value = false
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  handleDrop(e)
}

const typeIcons: Record<string, string> = {
  model: 'icon-[annon--layers]',
  entry: 'icon-[annon--file-text]',
  field: 'icon-[annon--code]',
}

const typeColors: Record<string, string> = {
  model: 'bg-primary-50 text-primary-700 border-primary-200 dark:bg-primary-950 dark:text-primary-300 dark:border-primary-800',
  entry: 'bg-success-50 text-success-700 border-success-200 dark:bg-success-950 dark:text-success-300 dark:border-success-800',
  field: 'bg-info-50 text-info-700 border-info-200 dark:bg-info-950 dark:text-info-300 dark:border-info-800',
}
</script>

<template>
  <!-- Drop zone hint (visible only during drag) -->
  <div
    v-if="isDragging && chips.length === 0"
    class="mx-3 mb-2 flex items-center justify-center rounded-lg border-2 border-dashed py-3 transition-colors"
    :class="isDragOver ? 'border-primary-400 bg-primary-50 dark:border-primary-600 dark:bg-primary-950' : 'border-secondary-300 dark:border-secondary-700'"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <span class="text-xs text-muted">{{ t('chat.drop_context') }}</span>
  </div>

  <!-- Context chips -->
  <div
    v-if="chips.length > 0"
    class="mx-3 mb-2 rounded-lg border border-secondary-200 bg-secondary-50 p-2 transition-colors dark:border-secondary-800 dark:bg-secondary-900"
    :class="isDragOver ? 'ring-2 ring-primary-500/30' : ''"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="flex flex-wrap items-center gap-1.5">
      <div
        v-for="chip in chips"
        :key="chip.id"
        class="inline-flex max-w-48 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium"
        :class="typeColors[chip.type]"
      >
        <span :class="typeIcons[chip.type]" class="size-3 shrink-0" aria-hidden="true" />
        <span class="truncate">{{ chip.label }}</span>
        <span v-if="chip.sublabel" class="truncate opacity-60">· {{ chip.sublabel }}</span>
        <button
          type="button"
          class="-mr-0.5 ml-1 flex shrink-0 items-center justify-center rounded-full p-0.5 transition-colors hover:bg-black/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current dark:hover:bg-white/10"
          @click="remove(chip.id)"
        >
          <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
          <span class="sr-only">{{ t('common.remove') }}</span>
        </button>
      </div>

      <!-- Clear all -->
      <button
        v-if="chips.length > 1"
        type="button"
        class="rounded-md px-1.5 py-1 text-[10px] text-muted transition-colors hover:bg-secondary-200 hover:text-heading focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
        @click="clear"
      >
        {{ t('common.clear_all') }}
      </button>
    </div>
  </div>
</template>
