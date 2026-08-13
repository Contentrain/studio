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

/**
 * When the entry was last written. Absent is normal, not an error: the field
 * arrived with `@contentrain/types@1.0.0` and is deliberately not backfilled —
 * an entry written before it existed has no recoverable value, and inventing
 * one would be worse than saying nothing, because it would sort.
 */
function getEntryUpdatedAt(entryId: string, metaData: Record<string, unknown> | null | undefined): string | null {
  if (!metaData) return null
  const entryMeta = metaData[entryId] as { updated_at?: string } | undefined
  const raw = entryMeta?.updated_at
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── Search + progressive rendering ─────────────────────────
// The list used to render every entry: one `<details>`, one stateful Radix
// dropdown and three action buttons each. At 1000 articles that is the whole
// cost of opening a model — not the data, the components. Rendering a page at a
// time fixes it without touching the row, and without a virtualiser (a new
// dependency, and rows change height when they expand).
const PAGE_SIZE = 50

const brain = useContentBrain()

const searchQuery = ref('')
const searchIds = ref<string[] | null>(null)
const searching = ref(false)
const visibleCount = ref(PAGE_SIZE)

const allIds = computed(() => Object.keys(props.content))

/**
 * Search runs against the brain's index, not the rendered rows — otherwise it
 * would only ever find what is already on screen, which is the opposite of what
 * it is for. The index holds every entry, so a match on page twenty is found
 * without paging there.
 */
const matchedIds = computed(() => {
  if (!searchQuery.value.trim()) return allIds.value
  if (!searchIds.value) return []
  // Intersect rather than trust the index: it is rebuilt per sync, so it can
  // briefly name an entry this locale's payload no longer has.
  const present = new Set(allIds.value)
  return searchIds.value.filter(id => present.has(id))
})

/**
 * An entry named by `?entry=` — the palette's search result — is pulled to the
 * front and opened. Otherwise "go to this entry" would drop someone at the top
 * of a thousand rows to find it themselves, which is what they searched to
 * avoid. Paging cannot hide it either: it is prepended, not paged to.
 */
const route = useRoute()
const targetEntryId = computed(() => {
  const id = route.query.entry
  return typeof id === 'string' && id in props.content ? id : null
})

const visibleEntries = computed(() => {
  const target = targetEntryId.value
  const ordered = target
    ? [target, ...matchedIds.value.filter(id => id !== target)]
    : matchedIds.value

  return ordered
    .slice(0, visibleCount.value)
    .map(id => ({ id, entry: props.content[id] as Record<string, unknown> }))
})
const hasMore = computed(() => matchedIds.value.length > visibleCount.value)

// Distinguishable from "nothing matched": the worker resolves an empty array
// when it is not there, and reporting that as no results is a lie.
const searchUnavailable = computed(() => !!searchQuery.value.trim() && !brain.searchReady.value)

// Hand-rolled rather than pulling in a utility library for one debounce. The
// token guards against a slow early query landing after a faster later one and
// overwriting it — the classic way a search box shows the wrong results.
let searchToken = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(searchQuery, (query) => {
  if (searchTimer) clearTimeout(searchTimer)
  visibleCount.value = PAGE_SIZE

  const trimmed = query.trim()
  if (!trimmed) {
    searchToken++
    searchIds.value = null
    searching.value = false
    return
  }

  searching.value = true
  searchTimer = setTimeout(async () => {
    const token = ++searchToken
    // A high limit on purpose: the palette wants a shortlist, a filtered list
    // wants every match. `hasMore` still keeps the render bounded.
    const results = await brain.searchContent(trimmed, {
      modelId: props.modelId,
      locale: props.locale,
      limit: 1000,
    })
    if (token !== searchToken) return
    searchIds.value = results.map(r => r.entryId)
    searching.value = false
  }, 200)
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

// A different model or locale is a different list; the old query and page
// position mean nothing there.
watch(() => [props.modelId, props.locale], () => {
  searchQuery.value = ''
  searchIds.value = null
  visibleCount.value = PAGE_SIZE
})

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
    <!-- Search. Runs against the brain's index, so it finds entries this list
         has not rendered — the whole point at 1000 articles. -->
    <div class="sticky top-0 z-10 border-b border-secondary-100 bg-white px-5 py-2.5 dark:border-secondary-800 dark:bg-secondary-950">
      <AtomsFormInput
        v-model="searchQuery"
        type="search"
        clearable
        size="sm"
        :placeholder="t('content.search_entries')"
        :aria-label="t('content.search_entries')"
      />
    </div>

    <div class="divide-y divide-secondary-100 dark:divide-secondary-800">
      <details
        v-for="{ id: entryId, entry } in visibleEntries" :key="entryId" class="group/entry" draggable="true"
        :open="entryId === targetEntryId"
        @dragstart="onEntryDragStart($event, entryId, entry)" @dragend="endDrag"
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
          <div class="flex items-start gap-6 border-t border-secondary-100 pt-2 dark:border-secondary-800">
            <div class="min-w-0">
              <AtomsSectionLabel label="ID" class="px-0 py-0" />
              <span class="font-mono text-xs text-disabled">{{ String(entryId) }}</span>
            </div>
            <div class="min-w-0">
              <AtomsSectionLabel :label="t('content.updated_at')" class="px-0 py-0" />
              <span class="text-xs text-disabled">
                {{ getEntryUpdatedAt(String(entryId), meta) ?? t('content.updated_at_unknown') }}
              </span>
            </div>
          </div>
        </div>
      </details>
    </div>
    <!-- Nothing to show, and why -->
    <div v-if="visibleEntries.length === 0" class="px-5 py-8">
      <AtomsEmptyState
        v-if="searchUnavailable"
        icon="icon-[annon--alert-triangle]"
        :title="t('content.search_unavailable_title')"
        :description="t('content.search_unavailable_description')"
      />
      <AtomsEmptyState
        v-else-if="searching"
        icon="icon-[annon--search]"
        :title="t('common.loading')"
        :description="t('content.searching_description')"
      />
      <AtomsEmptyState
        v-else-if="searchQuery.trim()"
        icon="icon-[annon--search]"
        :title="t('content.no_matches_title')"
        :description="t('content.no_matches_description')"
      />
    </div>

    <div class="flex items-center gap-3 border-t border-secondary-200 px-5 py-3 dark:border-secondary-800">
      <span class="min-w-0 flex-1 truncate text-xs text-muted">
        <template v-if="searchQuery.trim()">
          {{ t('content.entry_count_filtered', { shown: visibleEntries.length, matched: matchedIds.length, total: allIds.length }) }}
        </template>
        <template v-else-if="hasMore">
          {{ t('content.entry_count_partial', { shown: visibleEntries.length, total: allIds.length }) }}
        </template>
        <template v-else>
          {{ t('content.entry_count', { count: allIds.length }) }}
        </template>
      </span>
      <AtomsBaseButton
        v-if="hasMore"
        variant="ghost"
        size="sm"
        class="shrink-0"
        @click="visibleCount += PAGE_SIZE"
      >
        {{ t('content.show_more') }}
      </AtomsBaseButton>
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
