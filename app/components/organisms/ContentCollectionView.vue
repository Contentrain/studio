<script setup lang="ts">
import { activeModelMetaKey, getEntryTitleKey, getFieldTypeKey, getModelFieldsKey, getUserFieldIdsKey, sendChatPromptKey } from '~/utils/injection-keys'

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

// Resolve an entry's status from the id-keyed collection meta map. The badge +
// PATCH live in the shared MoleculesEntryStatusPicker (also used by documents).
function getEntryStatus(entryId: string, metaData: Record<string, unknown> | null | undefined): string | null {
  if (!metaData) return null
  const entryMeta = metaData[entryId] as { status?: string } | undefined
  return entryMeta?.status ?? null
}

const getFieldType = inject(getFieldTypeKey, () => 'string')
const getEntryTitle = inject(getEntryTitleKey, (_e: Record<string, unknown>, f: string) => f)
const getUserFieldIds = inject(getUserFieldIdsKey, () => [])
const modelMeta = inject(activeModelMetaKey, computed(() => null))
const getModelFields = inject(getModelFieldsKey, () => ({}))

const { toggle, isPinned, startDrag, endDrag } = useChatContext()
const sendChatPrompt = inject(sendChatPromptKey, () => { })

// A pin button is a toggle, so the label has to name the direction it will go —
// tooltip and `aria-label` both read from here so the two can never drift.
function pinLabel(kind: 'entry' | 'field', entryId: string, fieldId?: string) {
  const pinned = isPinned(kind, props.modelId ?? '', entryId, fieldId)
  if (pinned) return t('content.unpin')
  return kind === 'entry' ? t('content.pin_entry') : t('content.pin_field')
}

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
        v-for="(entry, entryId) in content" :key="String(entryId)" class="group/entry" draggable="true"
        @dragstart="onEntryDragStart($event, String(entryId), entry)" @dragend="endDrag"
      >
        <summary
          class="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900"
        >
          <span
            class="icon-[annon--chevron-right] size-3.5 shrink-0 text-muted transition-transform group-open/entry:rotate-90"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate font-medium text-heading dark:text-secondary-100">
            {{ getEntryTitle(entry, String(entryId)) }}
          </span>
          <!-- Edit entry (modal) -->
          <AtomsTooltip v-if="editable" :text="t('content.edit_entry')">
            <button
              type="button"
              class="reveal-on-hover shrink-0 rounded-md p-0.5 text-muted transition-[color,opacity] hover:text-primary-500 hover:opacity-100 group-hover/entry:opacity-60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
              :aria-label="t('content.edit_entry')" @click.prevent="openEditModal(String(entryId), entry)"
            >
              <span class="icon-[annon--edit-2] size-3" aria-hidden="true" />
            </button>
          </AtomsTooltip>
          <!-- Delete entry -->
          <AtomsTooltip v-if="editable" :text="t('content.delete_entry')">
            <button
              type="button" :aria-label="t('content.delete_entry')"
              class="reveal-on-hover shrink-0 rounded-md p-0.5 text-muted transition-[color,opacity] hover:text-danger-500 hover:opacity-100 group-hover/entry:opacity-60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
              @click.prevent="deleteEntry(String(entryId), entry)"
            >
              <span class="icon-[annon--trash] size-3" aria-hidden="true" />
            </button>
          </AtomsTooltip>
          <!-- Pin entry. The label says what pinning does — attach the entry to
               the chat's context — because "pin" alone never told anyone. -->
          <AtomsTooltip :text="pinLabel('entry', String(entryId))">
            <button
              type="button" :aria-label="pinLabel('entry', String(entryId))"
              :aria-pressed="isPinned('entry', modelId ?? '', String(entryId))"
              class="reveal-on-hover shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
              :class="isPinned('entry', modelId ?? '', String(entryId))
                ? 'text-primary-500 opacity-100'
                : 'text-muted hover:opacity-100 group-hover/entry:opacity-60'"
              @click="pinEntry($event, String(entryId), entry)"
            >
              <span class="icon-[annon--pin] size-3" aria-hidden="true" />
            </button>
          </AtomsTooltip>
          <!-- Status badge + picker (shared with the document view) -->
          <MoleculesEntryStatusPicker
            :status="getEntryStatus(String(entryId), meta)"
            :entry-id="String(entryId)"
            :workspace-id="workspaceId" :project-id="projectId" :model-id="modelId"
            :locale="locale" :editable="editable" @saved="emit('saved')"
          />
          <span class="shrink-0 font-mono text-[10px] text-disabled">
            {{ String(entryId).substring(0, 8) }}
          </span>
        </summary>
        <div class="space-y-3 px-5 pb-4 pt-1">
          <template v-for="fieldId in getUserFieldIds()" :key="fieldId">
            <div
              v-if="typeof entry === 'object' && entry !== null && fieldId in entry" class="group/field"
              draggable="true" @dragstart="onFieldDragStart($event, String(entryId), fieldId, entry[fieldId])"
              @dragend="endDrag"
            >
              <div class="flex items-center gap-1">
                <AtomsSectionLabel :label="fieldId" class="flex-1 px-0 py-0" />
                <!-- Pin field -->
                <AtomsTooltip :text="pinLabel('field', String(entryId), fieldId)">
                  <button
                    type="button" :aria-label="pinLabel('field', String(entryId), fieldId)"
                    :aria-pressed="isPinned('field', modelId ?? '', String(entryId), fieldId)"
                    class="reveal-on-hover shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                    :class="isPinned('field', modelId ?? '', String(entryId), fieldId)
                      ? 'text-info-500 opacity-100'
                      : 'text-muted hover:opacity-100 group-hover/field:opacity-60'"
                    @click="pinField($event, String(entryId), fieldId, entry[fieldId])"
                  >
                    <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
                  </button>
                </AtomsTooltip>
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
      <span class="text-xs text-muted">{{ t('content.entry_count', { count: Object.keys(content).length }) }}</span>
    </div>

    <!-- Edit modal -->
    <OrganismsContentEditModal
      v-if="editable && editModalEntryId" v-model:open="editModalOpen"
      :model-name="modelMeta?.name ?? ''" model-kind="collection" :fields="(getModelFields() as Record<string, any>)"
      :entry-id="editModalEntryId" :entry-data="editModalEntryData" :entry-title="editModalEntryTitle"
      :workspace-id="workspaceId ?? ''" :project-id="projectId ?? ''" :model-id="modelId ?? ''" :locale="locale ?? 'en'"
      @saved="handleModalSaved"
    />
  </div>
</template>
