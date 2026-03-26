<script setup lang="ts">
defineProps<{
  models: readonly { id: string, name: string, kind: string, type: string, fields: Readonly<Record<string, unknown>>, domain: string, i18n: boolean }[]
  content: Readonly<Record<string, { count: number, locales: string[] }>>
}>()

const emit = defineEmits<{
  select: [modelId: string]
}>()

const { toggle, isPinned, startDrag, endDrag } = useChatContext()
const sendChatPrompt = inject<(text: string) => void>('sendChatPrompt', () => {})

function onDelete(e: Event, model: { id: string, name: string }) {
  e.stopPropagation()
  sendChatPrompt(`Delete the ${model.name} model (ID: ${model.id}) and all its content.`)
}

function onPin(e: Event, model: { id: string, name: string, kind: string }) {
  e.stopPropagation()
  toggle({
    type: 'model',
    label: model.name,
    sublabel: model.kind,
    modelId: model.id,
    modelName: model.name,
  })
}

function onDragStart(e: DragEvent, model: { id: string, name: string, kind: string }) {
  startDrag(e, {
    type: 'model',
    label: model.name,
    sublabel: model.kind,
    modelId: model.id,
    modelName: model.name,
  })
}
</script>

<template>
  <div class="py-2">
    <div
      v-for="model in models"
      :key="model.id"
      class="group flex items-center"
    >
      <button
        type="button"
        draggable="true"
        class="flex min-w-0 flex-1 items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
        @click="emit('select', model.id)"
        @dragstart="onDragStart($event, model)"
        @dragend="endDrag"
      >
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary-100 dark:bg-secondary-800">
          <span :class="getModelKindIcon(model.kind ?? model.type)" class="size-4 text-muted" aria-hidden="true" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
            {{ model.name }}
          </div>
          <div class="flex items-center gap-2 text-xs text-muted">
            <span>{{ model.kind ?? model.type }}</span>
            <span v-if="content[model.id]?.locales">
              · {{ content[model.id]!.locales.length }} {{ content[model.id]!.locales.length === 1 ? 'locale' : 'locales' }}
            </span>
          </div>
        </div>
        <span class="icon-[annon--chevron-right] size-4 shrink-0 text-muted" aria-hidden="true" />
      </button>
      <!-- Delete model -->
      <button
        type="button"
        aria-label="Delete model"
        class="shrink-0 rounded-md p-1 text-muted opacity-0 transition-[color,opacity] hover:text-danger-500 hover:opacity-100 group-hover:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
        @click="onDelete($event, model)"
      >
        <span class="icon-[annon--trash] size-3.5" aria-hidden="true" />
      </button>
      <!-- Pin to context -->
      <button
        type="button"
        aria-label="Pin to context"
        class="mr-2 shrink-0 rounded-md p-1 transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
        :class="isPinned('model', model.id)
          ? 'text-primary-500 opacity-100'
          : 'text-muted opacity-0 hover:opacity-100 group-hover:opacity-60'"
        @click="onPin($event, model)"
      >
        <span class="icon-[annon--pin] size-3.5" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
