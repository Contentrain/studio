<script setup lang="ts">
import { marked } from 'marked'
import { activeModelMetaKey, getFieldTypeKey, getModelFieldsKey, getUserFieldIdsKey, sendChatPromptKey } from '~/utils/injection-keys'

defineProps<{
  entries: Array<{ slug: string, frontmatter: Record<string, unknown>, body: string }>
  workspaceId?: string
  projectId?: string
  modelId?: string
  locale?: string
  editable?: boolean
}>()

const emit = defineEmits<{
  saved: []
}>()

const { t } = useContent()
const { sanitize } = useSanitize()
const getFieldType = inject(getFieldTypeKey, () => 'string')
const getUserFieldIds = inject(getUserFieldIdsKey, () => [])
const modelMeta = inject(activeModelMetaKey, computed(() => null))
const getModelFields = inject(getModelFieldsKey, () => ({}))
const sendChatPrompt = inject(sendChatPromptKey, () => {})

const { toggle, isPinned, startDrag, endDrag } = useChatContext()

function renderMarkdown(md: string): string {
  return sanitize(marked.parse(md, { async: false }) as string)
}

// Context pin helpers
function pinEntry(e: Event, doc: { slug: string, frontmatter: Record<string, unknown>, body: string }) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  toggle({
    type: 'entry',
    label: (doc.frontmatter.title as string) || doc.slug,
    sublabel: meta.name,
    modelId: meta.id,
    modelName: meta.name,
    entryId: doc.slug,
    data: { ...doc.frontmatter, body: doc.body },
  })
}

function pinField(e: Event, slug: string, fieldId: string, value: unknown) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  toggle({
    type: 'field',
    label: fieldId,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    entryId: slug,
    fieldId,
    data: value,
  })
}

function onEntryDragStart(e: DragEvent, doc: { slug: string, frontmatter: Record<string, unknown>, body: string }) {
  const meta = modelMeta.value
  if (!meta) return
  startDrag(e, {
    type: 'entry',
    label: (doc.frontmatter.title as string) || doc.slug,
    sublabel: meta.name,
    modelId: meta.id,
    modelName: meta.name,
    entryId: doc.slug,
    data: { ...doc.frontmatter, body: doc.body },
  })
}

function onFieldDragStart(e: DragEvent, slug: string, fieldId: string, value: unknown) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  startDrag(e, {
    type: 'field',
    label: fieldId,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    entryId: slug,
    fieldId,
    data: value,
  })
}

// Delete entry via chat
function deleteEntry(doc: { slug: string, frontmatter: Record<string, unknown> }) {
  const title = (doc.frontmatter.title as string) || doc.slug
  const model = modelMeta.value?.name ?? ''
  sendChatPrompt(`Delete document "${title}" (slug: ${doc.slug}) from the ${model} model.`)
}

// Modal edit state
const editModalOpen = ref(false)
const editModalEntryId = ref<string | null>(null)
const editModalEntryData = ref<Record<string, unknown>>({})
const editModalEntryTitle = ref<string | undefined>()

function openEditModal(doc: { slug: string, frontmatter: Record<string, unknown>, body: string }) {
  editModalEntryId.value = doc.slug
  editModalEntryData.value = { ...doc.frontmatter, body: doc.body }
  editModalEntryTitle.value = (doc.frontmatter.title as string) || doc.slug
  editModalOpen.value = true
}

function handleModalSaved() {
  emit('saved')
}
</script>

<template>
  <div>
    <div class="divide-y divide-secondary-100 dark:divide-secondary-800">
      <details
        v-for="doc in entries"
        :key="doc.slug"
        class="group/entry"
        draggable="true"
        @dragstart="onEntryDragStart($event, doc)"
        @dragend="endDrag"
      >
        <summary class="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900">
          <span class="icon-[annon--chevron-right] size-3.5 shrink-0 text-muted transition-transform group-open/entry:rotate-90" aria-hidden="true" />
          <span class="icon-[annon--file-text] size-4 shrink-0 text-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate font-medium text-heading dark:text-secondary-100">
            {{ (doc.frontmatter.title as string) || doc.slug }}
          </span>
          <!-- Edit entry (modal) -->
          <button
            v-if="editable"
            type="button"
            class="shrink-0 rounded-md p-0.5 text-muted opacity-0 transition-[color,opacity] hover:text-primary-500 hover:opacity-100 group-hover/entry:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :aria-label="t('content.edit_entry')"
            @click.prevent="openEditModal(doc)"
          >
            <span class="icon-[annon--edit-2] size-3" aria-hidden="true" />
          </button>
          <!-- Delete entry -->
          <button
            v-if="editable"
            type="button"
            :aria-label="t('content.delete_entry')"
            class="shrink-0 rounded-md p-0.5 text-muted opacity-0 transition-[color,opacity] hover:text-danger-500 hover:opacity-100 group-hover/entry:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            @click.prevent="deleteEntry(doc)"
          >
            <span class="icon-[annon--trash] size-3" aria-hidden="true" />
          </button>
          <!-- Pin entry -->
          <button
            type="button"
            aria-label="Pin to context"
            class="shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :class="isPinned('entry', modelId ?? '', doc.slug)
              ? 'text-primary-500 opacity-100'
              : 'text-muted opacity-0 hover:opacity-100 group-hover/entry:opacity-60'"
            @click="pinEntry($event, doc)"
          >
            <span class="icon-[annon--pin] size-3" aria-hidden="true" />
          </button>
        </summary>
        <div class="space-y-3 px-5 pb-4 pt-1">
          <!-- Schema fields first -->
          <template v-for="fieldId in getUserFieldIds()" :key="fieldId">
            <div
              v-if="fieldId in doc.frontmatter"
              class="group/field"
              draggable="true"
              @dragstart="onFieldDragStart($event, doc.slug, fieldId, doc.frontmatter[fieldId])"
              @dragend="endDrag"
            >
              <div class="flex items-center gap-1">
                <AtomsSectionLabel :label="fieldId" class="flex-1 px-0 py-0" />
                <!-- Pin field -->
                <button
                  type="button"
                  class="shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  :class="isPinned('field', modelId ?? '', doc.slug, fieldId)
                    ? 'text-info-500 opacity-100'
                    : 'text-muted opacity-0 hover:opacity-100 group-hover/field:opacity-60'"
                  @click="pinField($event, doc.slug, fieldId, doc.frontmatter[fieldId])"
                >
                  <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
                </button>
              </div>
              <div class="mt-0.5">
                <AtomsContentFieldDisplay :type="getFieldType(fieldId)" :value="doc.frontmatter[fieldId]" :field-id="fieldId" />
              </div>
            </div>
          </template>
          <!-- Extra frontmatter fields not in schema -->
          <template v-for="(value, key) in doc.frontmatter" :key="'extra-' + String(key)">
            <div
              v-if="!getUserFieldIds().includes(String(key))"
              class="group/field"
              draggable="true"
              @dragstart="onFieldDragStart($event, doc.slug, String(key), value)"
              @dragend="endDrag"
            >
              <div class="flex items-center gap-1">
                <AtomsSectionLabel :label="String(key)" class="flex-1 px-0 py-0" />
                <button
                  type="button"
                  class="shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  :class="isPinned('field', modelId ?? '', doc.slug, String(key))
                    ? 'text-info-500 opacity-100'
                    : 'text-muted opacity-0 hover:opacity-100 group-hover/field:opacity-60'"
                  @click="pinField($event, doc.slug, String(key), value)"
                >
                  <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
                </button>
              </div>
              <div class="mt-0.5">
                <AtomsContentFieldDisplay type="string" :value="value" :field-id="String(key)" />
              </div>
            </div>
          </template>
          <!-- Rendered markdown body -->
          <div
            v-if="doc.body"
            class="group/field"
            draggable="true"
            @dragstart="onFieldDragStart($event, doc.slug, 'body', doc.body)"
            @dragend="endDrag"
          >
            <div class="flex items-center gap-1">
              <AtomsSectionLabel label="body" class="flex-1 px-0 py-0" />
              <button
                type="button"
                class="shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :class="isPinned('field', modelId ?? '', doc.slug, 'body')
                  ? 'text-info-500 opacity-100'
                  : 'text-muted opacity-0 hover:opacity-100 group-hover/field:opacity-60'"
                @click="pinField($event, doc.slug, 'body', doc.body)"
              >
                <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
              </button>
            </div>
            <div
              class="prose prose-sm prose-secondary mt-1 max-w-none rounded-lg bg-secondary-50 p-4 dark:prose-invert dark:bg-secondary-900"
              v-html="renderMarkdown(doc.body)"
            />
          </div>
        </div>
      </details>
    </div>
    <div class="border-t border-secondary-200 px-5 py-3 dark:border-secondary-800">
      <span class="text-xs text-muted">{{ entries.length }} documents</span>
    </div>

    <!-- Edit modal -->
    <OrganismsContentEditModal
      v-if="editable && editModalEntryId"
      v-model:open="editModalOpen"
      :model-name="modelMeta?.name ?? ''"
      model-kind="document"
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
