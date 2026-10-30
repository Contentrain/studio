<script setup lang="ts">
import type { ScheduleWindow } from '~~/shared/utils/entry-schedule'
import { activeModelMetaKey } from '~/utils/injection-keys'

const props = defineProps<{
  content: Record<string, unknown>
  /** The dictionary's one meta record for this locale (`status`, schedule). */
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

/** More keys than this in one modal stop being a form anyone can read. */
const EDIT_ALL_MAX = 50
/** A value this long, or with a line break, gets a textarea. */
const LONG_VALUE_CHARS = 80

const { t } = useContent()
const brain = useContentBrain()
const toast = useToast()
const { saving, saveField } = useContentEditor()
const searchQuery = ref('')
const modelMeta = inject(activeModelMetaKey, computed(() => null))
const { toggle, isPinned, startDrag, endDrag } = useChatContext()

const currentLocale = computed(() => props.locale ?? 'en')

// ── Default-locale reference ───────────────────────────────
// On an i18n dictionary the default locale is the reference set of keys: a key
// it has and this locale lacks is untranslated, and its value is what the
// translator works from.
const defaultLocale = computed(() => (brain.config.value as { locales?: { default?: string } } | null)?.locales?.default ?? 'en')
const isI18n = computed(() => brain.models.value.find(m => m.id === props.modelId)?.i18n === true)
const showsReference = computed(() => isI18n.value && currentLocale.value !== defaultLocale.value)
const reference = ref<Record<string, unknown>>({})

async function loadReference() {
  if (!showsReference.value || !props.modelId) {
    reference.value = {}
    return
  }
  const result = await brain.queryContent(props.modelId, defaultLocale.value)
  const data = result?.data
  reference.value = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
}

watch([() => props.modelId, currentLocale, () => brain.treeSha.value], () => void loadReference(), { immediate: true })

const missingKeys = computed(() => Object.keys(reference.value).filter(key => !(key in props.content)).sort())
const missingOnly = ref(false)

// A pin button is a toggle, so the label has to name the direction it will go —
// tooltip and `aria-label` both read from here so the two can never drift.
function pinLabel(key: string) {
  return isPinned('field', modelMeta.value?.id ?? '', undefined, key)
    ? t('content.unpin')
    : t('content.pin_field')
}

interface Row { key: string, value: unknown, missing: boolean }

const rows = computed<Row[]>(() => {
  const present: Row[] = Object.entries(props.content).map(([key, value]) => ({ key, value, missing: false }))
  const missing: Row[] = missingKeys.value.map(key => ({ key, value: reference.value[key], missing: true }))
  return missingOnly.value ? missing : [...present, ...missing]
})

const filteredEntries = computed(() => {
  if (!searchQuery.value) return rows.value
  const q = searchQuery.value.toLowerCase()
  return rows.value.filter(({ key, value }) =>
    key.toLowerCase().includes(q) || String(value).toLowerCase().includes(q),
  )
})

function pinKey(e: Event, key: string, value: unknown) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  toggle({
    type: 'field',
    label: key,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    fieldId: key,
    data: value,
  })
}

function onRowDragStart(e: DragEvent, key: string, value: unknown) {
  const meta = modelMeta.value
  if (!meta) return
  startDrag(e, {
    type: 'field',
    label: key,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    fieldId: key,
    data: value,
  })
}

// ── Edit ───────────────────────────────────────────────────
// The same modal and batch save as a singleton: the keys are the form's
// fields, and only the dirty ones are sent — MCP merges them into the file.
const editModalOpen = ref(false)
const editKeys = ref<string[]>([])

const editFields = computed(() => {
  const fields: Record<string, { type: string }> = {}
  for (const key of editKeys.value) {
    const value = String(props.content[key] ?? reference.value[key] ?? '')
    fields[key] = { type: value.length > LONG_VALUE_CHARS || value.includes('\n') ? 'text' : 'string' }
  }
  return fields
})

const editData = computed(() => {
  const data: Record<string, unknown> = {}
  for (const key of editKeys.value) data[key] = props.content[key] ?? ''
  return data
})

const canEditAll = computed(() => filteredEntries.value.length > 0 && filteredEntries.value.length <= EDIT_ALL_MAX)

function openEdit(keys: string[]) {
  editKeys.value = keys
  editModalOpen.value = true
}

function editAll() {
  if (!canEditAll.value) return
  openEdit(filteredEntries.value.map(r => r.key))
}

// The model view stays open on a save: a dictionary is edited a few keys at a
// time, and sending the editor back to the overview after each one (what the
// other kinds do) loses the filter and the place. The brain is re-synced so
// the open model, which follows the tree, reads the merged file again.
async function refresh() {
  if (props.workspaceId && props.projectId) {
    await brain.invalidate(props.projectId)
    await brain.sync(props.workspaceId, props.projectId)
  }
  emit('saved')
}

// ── Add key ────────────────────────────────────────────────
const newKey = ref('')
const newValue = ref('')
const keyInputRef = ref<HTMLInputElement | null>(null)

async function addKey() {
  const key = newKey.value.trim()
  const value = newValue.value
  if (!key || !value.trim() || !props.workspaceId || !props.projectId || !props.modelId) return
  // Saving an existing key would silently replace its value (MCP merges).
  if (key in props.content) {
    toast.error(t('content.dictionary_key_exists', { key }))
    return
  }
  const ok = await saveField(props.workspaceId, props.projectId, props.modelId, currentLocale.value, undefined, key, value)
  if (!ok) return
  newKey.value = ''
  newValue.value = ''
  keyInputRef.value?.focus()
  await refresh()
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Toolbar: status, filter, edit -->
    <div class="shrink-0 space-y-2 border-b border-secondary-200 px-5 py-2 dark:border-secondary-800">
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <AtomsFormInput v-model="searchQuery" type="search" :placeholder="t('content.filter_keys')" clearable />
        </div>
        <MoleculesEntryStatusPicker
          v-if="meta"
          :status="(meta.status as string | undefined) ?? null"
          :schedule="(meta as ScheduleWindow)"
          :entry-id="modelId ?? ''"
          :workspace-id="workspaceId" :project-id="projectId" :model-id="modelId"
          :locale="currentLocale" :editable="editable" @saved="refresh"
        />
        <AtomsTooltip v-if="editable" :text="canEditAll ? t('content.edit_content') : t('content.dictionary_narrow_filter', { max: EDIT_ALL_MAX })">
          <AtomsBaseButton size="sm" :disabled="!canEditAll" data-testid="dictionary-edit-all" @click="editAll">
            <template #prepend>
              <span class="icon-[annon--edit-2] size-3.5" aria-hidden="true" />
            </template>
            <span>{{ t('content.edit_content') }}</span>
          </AtomsBaseButton>
        </AtomsTooltip>
      </div>
      <button
        v-if="showsReference && missingKeys.length > 0"
        type="button"
        :aria-pressed="missingOnly"
        class="rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
        :class="missingOnly
          ? 'border-warning-300 bg-warning-50 text-warning-700 dark:border-warning-700 dark:bg-warning-950 dark:text-warning-300'
          : 'border-secondary-200 text-muted hover:text-body dark:border-secondary-700'"
        data-testid="dictionary-missing-filter"
        @click="missingOnly = !missingOnly"
      >
        {{ t('content.dictionary_missing_filter', { locale: currentLocale.toUpperCase(), count: missingKeys.length }) }}
      </button>
    </div>

    <!-- Table -->
    <div class="flex-1 overflow-y-auto">
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-white dark:bg-secondary-950">
          <tr class="border-b border-secondary-200 dark:border-secondary-800">
            <th class="px-5 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted">
              {{ t('content.key_column') }}
            </th>
            <th class="px-5 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted">
              {{ t('content.value_column') }}
            </th>
            <th class="w-14" />
          </tr>
        </thead>
        <tbody class="divide-y divide-secondary-100 dark:divide-secondary-800">
          <tr
            v-for="row in filteredEntries"
            :key="row.key"
            class="group hover:bg-secondary-50 dark:hover:bg-secondary-900"
            :draggable="!row.missing"
            @dragstart="onRowDragStart($event, row.key, row.value)"
            @dragend="endDrag"
          >
            <td class="max-w-40 truncate px-5 py-2 font-mono text-xs text-muted" :title="row.key">
              {{ row.key }}
            </td>
            <td class="max-w-48 truncate px-5 py-2" :title="String(row.value ?? '')">
              <template v-if="row.missing">
                <AtomsBadge variant="warning" size="sm" class="mr-1.5">
                  {{ t('content.dictionary_missing_badge') }}
                </AtomsBadge>
                <span class="text-disabled">{{ String(row.value ?? '') }}</span>
              </template>
              <span v-else class="text-heading dark:text-secondary-100">{{ String(row.value) }}</span>
            </td>
            <td class="pr-3">
              <div class="flex items-center justify-end gap-1">
                <AtomsTooltip v-if="editable" :text="t('content.dictionary_edit_key')">
                  <button
                    type="button"
                    :aria-label="t('content.dictionary_edit_key')"
                    class="reveal-on-hover shrink-0 rounded-md p-0.5 text-muted transition-[color,opacity] hover:opacity-100 group-hover:opacity-60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                    data-testid="dictionary-edit-key"
                    @click="openEdit([row.key])"
                  >
                    <span class="icon-[annon--edit-2] size-2.5" aria-hidden="true" />
                  </button>
                </AtomsTooltip>
                <AtomsTooltip v-if="!row.missing" :text="pinLabel(row.key)">
                  <button
                    type="button"
                    :aria-label="pinLabel(row.key)"
                    :aria-pressed="isPinned('field', modelMeta?.id ?? '', undefined, row.key)"
                    class="reveal-on-hover shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                    :class="isPinned('field', modelMeta?.id ?? '', undefined, row.key)
                      ? 'text-info-500 opacity-100'
                      : 'text-muted hover:opacity-100 group-hover:opacity-60'"
                    @click="pinKey($event, row.key, row.value)"
                  >
                    <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
                  </button>
                </AtomsTooltip>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="filteredEntries.length === 0" class="p-5">
        <AtomsEmptyState icon="icon-[annon--search]" :title="t('content.no_matches_title')" :description="t('content.no_matches_description')" />
      </div>
    </div>

    <!-- Add key: the vocabulary's inline row -->
    <form
      v-if="editable"
      class="flex shrink-0 items-center gap-2 border-t border-secondary-200 px-5 py-3 dark:border-secondary-800"
      data-testid="dictionary-add-key"
      @submit.prevent="addKey"
    >
      <input
        ref="keyInputRef"
        v-model="newKey"
        type="text"
        :aria-label="t('content.dictionary_key_placeholder')"
        :placeholder="t('content.dictionary_key_placeholder')"
        class="h-8 w-36 shrink-0 rounded-lg border border-secondary-200 bg-white px-2.5 font-mono text-xs text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
      >
      <input
        v-model="newValue"
        type="text"
        :aria-label="t('content.dictionary_value_placeholder')"
        :placeholder="t('content.dictionary_value_placeholder')"
        class="h-8 min-w-0 flex-1 rounded-lg border border-secondary-200 bg-white px-2.5 text-sm text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
      >
      <AtomsBaseButton
        type="submit"
        variant="primary"
        size="sm"
        class="shrink-0"
        :aria-label="t('content.dictionary_add_key')"
        :disabled="saving || !newKey.trim() || !newValue.trim()"
      >
        <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
      </AtomsBaseButton>
    </form>

    <!-- Footer -->
    <div class="shrink-0 border-t border-secondary-200 px-5 py-2 dark:border-secondary-800">
      <span class="text-xs text-muted">
        {{ filteredEntries.length }}{{ searchQuery || missingOnly ? ` / ${Object.keys(content).length}` : '' }} {{ t('content.keys_count') }}
      </span>
    </div>

    <!-- Edit modal -->
    <OrganismsContentEditModal
      v-if="editable"
      v-model:open="editModalOpen"
      :model-name="modelMeta?.name ?? ''"
      model-kind="dictionary"
      :fields="editFields"
      :entry-data="editData"
      :workspace-id="workspaceId ?? ''"
      :project-id="projectId ?? ''"
      :model-id="modelId ?? ''"
      :locale="currentLocale"
      :reference-data="reference"
      :reference-locale="showsReference ? defaultLocale : undefined"
      @saved="refresh"
    />
  </div>
</template>
