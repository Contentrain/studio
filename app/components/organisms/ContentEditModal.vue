<script setup lang="ts">
import { AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogOverlay, AlertDialogPortal, AlertDialogRoot, AlertDialogTitle, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'
import { buildRelationOptions, inferFieldType, isPolymorphicRelation } from '~/utils/content-relations'

interface FieldDef {
  type: string
  required?: boolean
  min?: number
  max?: number
  options?: string[]
  model?: string | string[]
  items?: string | FieldDef
  fields?: Record<string, FieldDef>
  description?: string
}

const { t } = useContent()
const brain = useContentBrain()

const {
  modelName,
  modelKind,
  fields,
  entryId,
  entryData,
  entryTitle,
  workspaceId,
  projectId,
  modelId,
  locale,
} = defineProps<{
  modelName: string
  modelKind: 'collection' | 'singleton' | 'document'
  fields: Record<string, FieldDef>
  entryId?: string
  entryData: Record<string, unknown>
  entryTitle?: string
  workspaceId: string
  projectId: string
  modelId: string
  locale: string
}>()

const emit = defineEmits<{
  saved: []
}>()

const open = defineModel<boolean>('open', { default: false })

const {
  batchEditData,
  saving,
  saveError,
  hasBatchChanges,
  dirtyFieldCount,
  startBatchEdit,
  updateBatchField,
  cancelBatchEdit,
  saveBatch,
} = useContentEditor()

// System fields — never show in editor
const SYSTEM_FIELDS = new Set([
  'id', 'ID', 'status', 'source',
  'updated_by', 'updated_at', 'approved_by',
  'createdAt', 'updatedAt',
])

const editableFieldIds = computed(() => {
  const ids = Object.keys(fields).filter(id => !SYSTEM_FIELDS.has(id))
  if (modelKind !== 'document') return ids
  // Documents store their fields as YAML frontmatter, which can carry keys
  // beyond the model schema (and the schema may be minimal). Surface every
  // frontmatter key so nothing is silently un-editable — this mirrors how
  // ContentDocumentView renders extra frontmatter fields in read mode.
  for (const key of Object.keys(entryData)) {
    if (key === 'body' || SYSTEM_FIELDS.has(key)) continue
    if (!ids.includes(key)) ids.push(key)
  }
  // Markdown body lives outside the schema.
  if (!ids.includes('body')) ids.push('body')
  return ids
})

// Merged field definitions — schema fields + synthetic body for documents +
// inferred defs for any frontmatter key the schema doesn't describe.
const mergedFields = computed(() => {
  if (modelKind !== 'document') return fields
  const merged: Record<string, FieldDef> = { ...fields }
  for (const id of editableFieldIds.value) {
    if (id === 'body' || merged[id]) continue
    merged[id] = { type: inferFieldType(entryData[id]) }
  }
  merged.body = { type: 'markdown', ...fields.body } as FieldDef
  return merged
})

// Relation entries for relation fields
const relationEntriesMap = ref<Record<string, Array<{ value: string, label: string }>>>({})

// Required field validation — only after user attempts to save
const showValidation = ref(false)

const requiredErrors = computed(() => {
  if (!batchEditData.value || !showValidation.value) return new Set<string>()
  const errors = new Set<string>()
  for (const fieldId of editableFieldIds.value) {
    const def = mergedFields.value[fieldId]
    if (!def?.required) continue
    const val = batchEditData.value[fieldId]
    if (val === null || val === undefined || val === '' || (Array.isArray(val) && val.length === 0)) {
      errors.add(fieldId)
    }
  }
  return errors
})

const hasValidationErrors = computed(() => requiredErrors.value.size > 0)

// Title for the modal header
const dialogTitle = computed(() => {
  if (modelKind === 'singleton') return modelName
  if (modelKind === 'document') return entryTitle ?? t('content.edit_entry')
  return entryTitle ?? t('content.edit_entry')
})

// Initialize batch editing when modal opens
watch(open, (isOpen) => {
  if (isOpen) {
    showValidation.value = false
    startBatchEdit(entryData)
    loadRelationEntries()
  }
  else {
    cancelBatchEdit()
    relationEntriesMap.value = {}
  }
}, { immediate: true })

async function loadRelationEntries() {
  // Target-model content is already in the Content Brain (synced for the whole
  // project). The old `GET /content/:modelId` route was removed when the brain
  // replaced per-model fetches, so read from the brain instead of a dead route.
  const map: Record<string, Array<{ value: string, label: string }>> = {}
  const defaultLocale = (brain.config.value as { locales?: { default?: string } } | null)?.locales?.default

  for (const [fieldId, def] of Object.entries(mergedFields.value)) {
    if (def.type !== 'relation' && def.type !== 'relations') continue
    if (!def.model) continue

    const targetModels = Array.isArray(def.model) ? def.model : [def.model]
    const polymorphic = isPolymorphicRelation(def.model)
    const options: Array<{ value: string, label: string }> = []

    for (const targetModelId of targetModels) {
      let result = await brain.queryContent(targetModelId, locale)
      // Non-i18n targets are stored under the default locale only.
      if (!result?.data && defaultLocale && defaultLocale !== locale) {
        result = await brain.queryContent(targetModelId, defaultLocale)
      }
      options.push(...buildRelationOptions(targetModelId, result?.data, polymorphic))
    }

    map[fieldId] = options
  }

  relationEntriesMap.value = map
}

function getFieldState(fieldId: string): 'default' | 'error' {
  return requiredErrors.value.has(fieldId) ? 'error' : 'default'
}

async function handleSave() {
  showValidation.value = true
  if (hasValidationErrors.value) return
  const success = await saveBatch(workspaceId, projectId, modelId, locale, entryId)
  if (success) {
    open.value = false
    emit('saved')
  }
}

const showDiscardConfirm = ref(false)

function handleClose() {
  if (hasBatchChanges.value) {
    showDiscardConfirm.value = true
    return
  }
  open.value = false
}

function confirmDiscard() {
  showDiscardConfirm.value = false
  open.value = false
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />

      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 flex w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-secondary-200 bg-white shadow-xl max-sm:inset-0 max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent="handleClose" @escape-key-down.prevent="handleClose"
      >
        <!-- Header -->
        <div
          class="flex shrink-0 items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800"
        >
          <div>
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ dialogTitle }}
            </DialogTitle>
            <DialogDescription class="mt-0.5 text-xs text-muted">
              {{ modelName }} &middot; {{ locale.toUpperCase() }}
            </DialogDescription>
          </div>
          <button
            type="button"
            class="rounded-lg p-1.5 text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
            @click="handleClose"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
            <span class="sr-only">{{ t('common.close') }}</span>
          </button>
        </div>

        <!-- Body (scrollable) -->
        <div class="flex-1 overflow-y-auto px-6 py-5 max-sm:max-h-none" style="max-height: 60vh;">
          <div v-if="batchEditData" class="space-y-5">
            <div v-for="fieldId in editableFieldIds" :key="fieldId">
              <AtomsFormLabel :text="fieldId" size="sm" :required="mergedFields[fieldId]?.required" />
              <p v-if="mergedFields[fieldId]?.description" class="mb-1 text-xs text-muted">
                {{ mergedFields[fieldId].description }}
              </p>
              <div class="mt-1.5">
                <AtomsContentFieldEditor
                  :type="mergedFields[fieldId]?.type ?? 'string'" :model-value="batchEditData[fieldId]"
                  :field-id="fieldId" :field-def="mergedFields[fieldId]" :options="mergedFields[fieldId]?.options"
                  :related-entries="relationEntriesMap[fieldId]" :standalone="false"
                  @update:model-value="updateBatchField(fieldId, $event)"
                />
              </div>
              <p v-if="getFieldState(fieldId) === 'error'" class="mt-1 text-xs text-danger-500">
                {{ t('content.field_required') }}
              </p>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div
          class="flex shrink-0 items-center justify-between border-t border-secondary-200 px-6 py-4 dark:border-secondary-800"
        >
          <div>
            <AtomsBadge v-if="dirtyFieldCount > 0" variant="info" size="sm">
              {{ t('content.dirty_count', { count: dirtyFieldCount }) }}
            </AtomsBadge>
          </div>
          <div class="flex items-center gap-2">
            <AtomsBaseButton size="sm" :disabled="saving" @click="handleClose">
              <span>{{ t('common.cancel') }}</span>
            </AtomsBaseButton>
            <AtomsBaseButton variant="primary" size="sm" :disabled="saving || !hasBatchChanges" @click="handleSave">
              <span>{{ saving ? t('common.connecting') : t('content.save_all') }}</span>
            </AtomsBaseButton>
          </div>
        </div>

        <!-- Server error -->
        <div
          v-if="saveError"
          class="border-t border-danger-200 bg-error px-6 py-3 dark:border-danger-800 dark:bg-danger-950"
        >
          <p class="text-xs text-danger-600 dark:text-danger-400">
            {{ saveError }}
          </p>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <!-- Unsaved changes confirmation -->
  <AlertDialogRoot v-model:open="showDiscardConfirm">
    <AlertDialogPortal>
      <AlertDialogOverlay
        class="fixed inset-0 z-60 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />
      <AlertDialogContent
        class="fixed left-1/2 top-1/2 z-60 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-secondary-200 bg-white p-6 shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
      >
        <AlertDialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
          {{ t('content.unsaved_title') }}
        </AlertDialogTitle>
        <AlertDialogDescription class="mt-2 text-sm text-body dark:text-secondary-300">
          {{ t('content.unsaved_description') }}
        </AlertDialogDescription>
        <div class="mt-5 flex items-center justify-end gap-2">
          <AlertDialogCancel as-child>
            <AtomsBaseButton size="sm">
              <span>{{ t('content.keep_editing') }}</span>
            </AtomsBaseButton>
          </AlertDialogCancel>
          <AlertDialogAction as-child>
            <AtomsBaseButton variant="danger" size="sm" @click="confirmDiscard">
              <span>{{ t('content.discard') }}</span>
            </AtomsBaseButton>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
