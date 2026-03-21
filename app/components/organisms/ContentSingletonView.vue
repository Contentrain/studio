<script setup lang="ts">
const props = defineProps<{
  content: Record<string, unknown>
  workspaceId?: string
  projectId?: string
  modelId?: string
  locale?: string
  editable?: boolean
}>()

const emit = defineEmits<{
  saved: []
}>()

const getFieldType = inject<(fieldId: string) => string>('getFieldType', () => 'string')
const getUserFieldIds = inject<() => string[]>('getUserFieldIds', () => [])
const modelMeta = inject<ComputedRef<{ id: string, name: string, kind: string } | null>>('activeModelMeta', computed(() => null))

const { editingField, editValue, saving, startEdit, cancelEdit, saveField } = useContentEditor()
const { toggle, isPinned, startDrag, endDrag } = useChatContext()

async function handleSave(fieldId: string) {
  if (!props.workspaceId || !props.projectId || !props.modelId) return
  const success = await saveField(
    props.workspaceId,
    props.projectId,
    props.modelId,
    props.locale ?? 'en',
    undefined,
    fieldId,
    editValue.value,
  )
  if (success) emit('saved')
}

function pinField(e: Event, fieldId: string, value: unknown) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  toggle({
    type: 'field',
    label: fieldId,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    fieldId,
    data: value,
  })
}

function onFieldDragStart(e: DragEvent, fieldId: string, value: unknown) {
  const meta = modelMeta.value
  if (!meta) return
  startDrag(e, {
    type: 'field',
    label: fieldId,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    fieldId,
    data: value,
  })
}
</script>

<template>
  <div class="space-y-4 p-5">
    <template v-for="fieldId in getUserFieldIds()" :key="fieldId">
      <div
        v-if="fieldId in content"
        class="group/field"
        draggable="true"
        @dragstart="onFieldDragStart($event, fieldId, content[fieldId])"
        @dragend="endDrag"
      >
        <div class="flex items-center gap-1">
          <AtomsSectionLabel :label="fieldId" class="flex-1 px-0 py-0" />
          <!-- Pin field -->
          <button
            type="button"
            class="shrink-0 rounded-md p-0.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :class="isPinned('field', modelId ?? '', undefined, fieldId)
              ? 'text-info-500 opacity-100'
              : 'text-muted opacity-0 hover:opacity-100 group-hover/field:opacity-60'"
            @click="pinField($event, fieldId, content[fieldId])"
          >
            <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
          </button>
        </div>
        <div class="mt-1">
          <!-- Edit mode -->
          <AtomsContentFieldEditor
            v-if="editable && editingField === fieldId"
            v-model="editValue"
            :type="getFieldType(fieldId)"
            :field-id="fieldId"
            :saving="saving"
            @save="handleSave(fieldId)"
            @cancel="cancelEdit"
          />
          <!-- Display mode (click to edit) -->
          <div
            v-else
            :class="editable ? 'cursor-pointer rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900' : ''"
            @click="editable ? startEdit(fieldId, content[fieldId]) : undefined"
          >
            <AtomsContentFieldDisplay :type="getFieldType(fieldId)" :value="content[fieldId]" :field-id="fieldId" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
