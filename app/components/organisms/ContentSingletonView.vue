<script setup lang="ts">
defineProps<{
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

const { toggle, isPinned, startDrag, endDrag } = useChatContext()
const { t } = useContent()
const getModelFields = inject<() => Record<string, unknown>>('getModelFields', () => ({}))

// Modal edit state
const editModalOpen = ref(false)

function openEditModal() {
  editModalOpen.value = true
}

function handleModalSaved() {
  emit('saved')
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
    <!-- Edit all button -->
    <div v-if="editable" class="flex justify-end">
      <AtomsBaseButton size="sm" @click="openEditModal">
        <template #prepend>
          <span class="icon-[annon--edit-2] size-3.5" aria-hidden="true" />
        </template>
        <span>{{ t('content.edit_content') }}</span>
      </AtomsBaseButton>
    </div>

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
            class="shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :class="isPinned('field', modelId ?? '', undefined, fieldId)
              ? 'text-info-500 opacity-100'
              : 'text-muted opacity-0 hover:opacity-100 group-hover/field:opacity-60'"
            @click="pinField($event, fieldId, content[fieldId])"
          >
            <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
          </button>
        </div>
        <div class="mt-1">
          <AtomsContentFieldDisplay :type="getFieldType(fieldId)" :value="content[fieldId]" :field-id="fieldId" />
        </div>
      </div>
    </template>

    <!-- Edit modal -->
    <OrganismsContentEditModal
      v-if="editable"
      v-model:open="editModalOpen"
      :model-name="modelMeta?.name ?? ''"
      model-kind="singleton"
      :fields="(getModelFields() as Record<string, any>)"
      :entry-data="content"
      :workspace-id="workspaceId ?? ''"
      :project-id="projectId ?? ''"
      :model-id="modelId ?? ''"
      :locale="locale ?? 'en'"
      @saved="handleModalSaved"
    />
  </div>
</template>
