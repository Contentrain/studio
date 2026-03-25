<script setup lang="ts">
const { t } = useContent()

const props = defineProps<{
  content: Record<string, Record<string, unknown>>
  meta?: Record<string, unknown> | null
  workspaceId?: string
  projectId?: string
  modelId?: string
  locale?: string
  editable?: boolean
}>()

const emit = defineEmits<{
  saved: []
}>()

const toast = useToast()
const { isOwnerOrAdmin } = useWorkspaceRole()

async function togglePublish(entryId: string) {
  if (!props.workspaceId || !props.projectId || !props.modelId) return
  const currentStatus = getEntryStatus(entryId, props.meta)
  const newStatus = currentStatus === 'published' ? 'draft' : 'published'

  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/content/${props.modelId}/status`, {
      method: 'PATCH',
      body: { entryIds: [entryId], status: newStatus, locale: props.locale ?? 'en' },
    })
    toast.success(newStatus === 'published' ? 'Published' : 'Unpublished')
    emit('saved')
  }
  catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : 'Failed to update status')
  }
}

const statusVariants: Record<string, { variant: 'success' | 'warning' | 'primary' | 'secondary' | 'danger', label: string }> = {
  published: { variant: 'success', label: 'published' },
  draft: { variant: 'warning', label: 'draft' },
  in_review: { variant: 'primary', label: 'review' },
  rejected: { variant: 'danger', label: 'rejected' },
  archived: { variant: 'secondary', label: 'archived' },
}

function getEntryStatus(entryId: string, metaData: Record<string, unknown> | null | undefined): string | null {
  if (!metaData) return null
  const entryMeta = metaData[entryId] as { status?: string } | undefined
  return entryMeta?.status ?? null
}

const getFieldType = inject<(fieldId: string) => string>('getFieldType', () => 'string')
const getEntryTitle = inject<(entry: Record<string, unknown>, fallback: string) => string>('getEntryTitle', (_e, f) => f)
const getUserFieldIds = inject<() => string[]>('getUserFieldIds', () => [])
const modelMeta = inject<ComputedRef<{ id: string, name: string, kind: string } | null>>('activeModelMeta', computed(() => null))
const getModelFields = inject<() => Record<string, unknown>>('getModelFields', () => ({}))

const { toggle, isPinned, startDrag, endDrag } = useChatContext()
const sendChatPrompt = inject<(text: string) => void>('sendChatPrompt', () => {})

function deleteEntry(entryId: string, entry: Record<string, unknown>) {
  const title = getEntryTitle(entry, entryId.substring(0, 8))
  const model = modelMeta.value?.name ?? ''
  sendChatPrompt(`Delete entry "${title}" (ID: ${entryId}) from the ${model} model.`)
}

// Modal edit state
const editModalOpen = ref(false)
const editModalEntryId = ref<string | null>(null)
const editModalEntryData = ref<Record<string, unknown>>({})
const editModalEntryTitle = ref<string | undefined>()

function openEditModal(entryId: string, entry: Record<string, unknown>) {
  editModalEntryId.value = entryId
  editModalEntryData.value = entry
  editModalEntryTitle.value = getEntryTitle(entry, entryId.substring(0, 8))
  editModalOpen.value = true
}

function handleModalSaved() {
  emit('saved')
}

// Context pin helpers
function pinEntry(e: Event, entryId: string, entry: Record<string, unknown>) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  toggle({
    type: 'entry',
    label: getEntryTitle(entry, String(entryId)),
    sublabel: meta.name,
    modelId: meta.id,
    modelName: meta.name,
    entryId: String(entryId),
    data: entry,
  })
}

function pinField(e: Event, entryId: string, fieldId: string, value: unknown) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  toggle({
    type: 'field',
    label: fieldId,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    entryId: String(entryId),
    fieldId,
    data: value,
  })
}

function onEntryDragStart(e: DragEvent, entryId: string, entry: Record<string, unknown>) {
  const meta = modelMeta.value
  if (!meta) return
  startDrag(e, {
    type: 'entry',
    label: getEntryTitle(entry, String(entryId)),
    sublabel: meta.name,
    modelId: meta.id,
    modelName: meta.name,
    entryId: String(entryId),
    data: entry,
  })
}

function onFieldDragStart(e: DragEvent, entryId: string, fieldId: string, value: unknown) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  startDrag(e, {
    type: 'field',
    label: fieldId,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    entryId: String(entryId),
    fieldId,
    data: value,
  })
}
</script>

<template>
  <div>
    <div class="divide-y divide-secondary-100 dark:divide-secondary-800">
      <details
        v-for="(entry, entryId) in content"
        :key="String(entryId)"
        class="group/entry"
        draggable="true"
        @dragstart="onEntryDragStart($event, String(entryId), entry)"
        @dragend="endDrag"
      >
        <summary class="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900">
          <span class="icon-[annon--chevron-right] size-3.5 shrink-0 text-muted transition-transform group-open/entry:rotate-90" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate font-medium text-heading dark:text-secondary-100">
            {{ getEntryTitle(entry, String(entryId)) }}
          </span>
          <!-- Edit entry (modal) -->
          <button
            v-if="editable"
            type="button"
            class="shrink-0 rounded-md p-0.5 text-muted opacity-0 transition-all hover:text-primary-500 hover:opacity-100 group-hover/entry:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :aria-label="t('content.edit_entry')"
            @click.prevent="openEditModal(String(entryId), entry)"
          >
            <span class="icon-[annon--edit-2] size-3" aria-hidden="true" />
          </button>
          <!-- Delete entry -->
          <button
            v-if="editable"
            type="button"
            :aria-label="t('content.delete_entry')"
            class="shrink-0 rounded-md p-0.5 text-muted opacity-0 transition-all hover:text-danger-500 hover:opacity-100 group-hover/entry:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            @click.prevent="deleteEntry(String(entryId), entry)"
          >
            <span class="icon-[annon--trash] size-3" aria-hidden="true" />
          </button>
          <!-- Pin entry -->
          <button
            type="button"
            aria-label="Pin to context"
            class="shrink-0 rounded-md p-0.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :class="isPinned('entry', modelId ?? '', String(entryId))
              ? 'text-primary-500 opacity-100'
              : 'text-muted opacity-0 hover:opacity-100 group-hover/entry:opacity-60'"
            @click="pinEntry($event, String(entryId), entry)"
          >
            <span class="icon-[annon--pin] size-3" aria-hidden="true" />
          </button>
          <!-- Status badge (clickable for owner/admin to publish/unpublish) -->
          <button
            v-if="getEntryStatus(String(entryId), meta) && isOwnerOrAdmin && editable"
            type="button"
            class="shrink-0 rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :title="getEntryStatus(String(entryId), meta) === 'published' ? 'Unpublish' : 'Publish'"
            @click.prevent="togglePublish(String(entryId))"
          >
            <AtomsBadge
              :variant="statusVariants[getEntryStatus(String(entryId), meta)!]?.variant ?? 'secondary'"
              size="sm"
            >
              {{ statusVariants[getEntryStatus(String(entryId), meta)!]?.label ?? getEntryStatus(String(entryId), meta) }}
            </AtomsBadge>
          </button>
          <AtomsBadge
            v-else-if="getEntryStatus(String(entryId), meta)"
            :variant="statusVariants[getEntryStatus(String(entryId), meta)!]?.variant ?? 'secondary'"
            size="sm"
            class="shrink-0"
          >
            {{ statusVariants[getEntryStatus(String(entryId), meta)!]?.label ?? getEntryStatus(String(entryId), meta) }}
          </AtomsBadge>
          <span class="shrink-0 font-mono text-[10px] text-disabled">
            {{ String(entryId).substring(0, 8) }}
          </span>
        </summary>
        <div class="space-y-3 px-5 pb-4 pt-1">
          <template v-for="fieldId in getUserFieldIds()" :key="fieldId">
            <div
              v-if="typeof entry === 'object' && entry !== null && fieldId in entry"
              class="group/field"
              draggable="true"
              @dragstart="onFieldDragStart($event, String(entryId), fieldId, entry[fieldId])"
              @dragend="endDrag"
            >
              <div class="flex items-center gap-1">
                <AtomsSectionLabel :label="fieldId" class="flex-1 px-0 py-0" />
                <!-- Pin field -->
                <button
                  type="button"
                  class="shrink-0 rounded-md p-0.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  :class="isPinned('field', modelId ?? '', String(entryId), fieldId)
                    ? 'text-info-500 opacity-100'
                    : 'text-muted opacity-0 hover:opacity-100 group-hover/field:opacity-60'"
                  @click="pinField($event, String(entryId), fieldId, entry[fieldId])"
                >
                  <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
                </button>
              </div>
              <div class="mt-0.5">
                <AtomsContentFieldDisplay :type="getFieldType(fieldId)" :value="entry[fieldId]" :field-id="fieldId" />
              </div>
            </div>
          </template>
          <div class="border-t border-secondary-100 pt-2 dark:border-secondary-800">
            <AtomsSectionLabel label="ID" class="px-0 py-0" />
            <span class="font-mono text-xs text-disabled">{{ String(entryId) }}</span>
          </div>
        </div>
      </details>
    </div>
    <div class="border-t border-secondary-200 px-5 py-3 dark:border-secondary-800">
      <span class="text-xs text-muted">{{ Object.keys(content).length }} entries</span>
    </div>

    <!-- Edit modal -->
    <OrganismsContentEditModal
      v-if="editable && editModalEntryId"
      v-model:open="editModalOpen"
      :model-name="modelMeta?.name ?? ''"
      model-kind="collection"
      :fields="(getModelFields() as Record<string, any>)"
      :entry-id="editModalEntryId"
      :entry-data="editModalEntryData"
      :entry-title="editModalEntryTitle"
      :workspace-id="workspaceId ?? ''"
      :project-id="projectId ?? ''"
      :model-id="modelId ?? ''"
      :locale="locale ?? 'en'"
      @saved="handleModalSaved"
    />
  </div>
</template>
