<script setup lang="ts">
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'

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
  modelKind: 'collection' | 'singleton'
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

const editableFieldIds = computed(() =>
  Object.keys(fields).filter(id => !SYSTEM_FIELDS.has(id)),
)

// Relation entries for relation fields
const relationEntriesMap = ref<Record<string, Array<{ value: string, label: string }>>>({})

// Required field validation — only after user attempts to save
const showValidation = ref(false)

const requiredErrors = computed(() => {
  if (!batchEditData.value || !showValidation.value) return new Set<string>()
  const errors = new Set<string>()
  for (const fieldId of editableFieldIds.value) {
    const def = fields[fieldId]
    if (!def?.required) continue
    const val = batchEditData.value[fieldId]
    if (val === null || val === undefined || val === '') {
      errors.add(fieldId)
    }
  }
  return errors
})

const hasValidationErrors = computed(() => requiredErrors.value.size > 0)

// Title for the modal header
const dialogTitle = computed(() => {
  if (modelKind === 'singleton') return modelName
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
  for (const [fieldId, def] of Object.entries(fields)) {
    if (def.type !== 'relation' && def.type !== 'relations') continue
    if (!def.model) continue

    const targetModels = Array.isArray(def.model) ? def.model : [def.model]
    const entries: Array<{ value: string, label: string }> = []

    for (const targetModelId of targetModels) {
      try {
        const result = await $fetch<{ data: unknown }>(`/api/workspaces/${workspaceId}/projects/${projectId}/content/${targetModelId}`, {
          params: { locale },
        })
        if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
          for (const [id, entry] of Object.entries(result.data as Record<string, Record<string, unknown>>)) {
            const label = findEntryLabel(entry) ?? id.substring(0, 8)
            entries.push({ value: id, label: targetModels.length > 1 ? `${targetModelId}: ${label}` : label })
          }
        }
      }
      catch {
        // Target model content not available
      }
    }

    relationEntriesMap.value[fieldId] = entries
  }
}

function findEntryLabel(entry: Record<string, unknown>): string | null {
  for (const key of ['name', 'title', 'label', 'slug']) {
    if (typeof entry[key] === 'string' && entry[key]) return entry[key] as string
  }
  for (const value of Object.values(entry)) {
    if (typeof value === 'string' && value.length > 0 && value.length < 80) return value
  }
  return null
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

function handleClose() {
  if (hasBatchChanges.value) {
    if (!window.confirm(t('content.unsaved_changes'))) return
  }
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
        @interact-outside.prevent="handleClose"
        @escape-key-down.prevent="handleClose"
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
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
              <AtomsFormLabel
                :text="fieldId"
                size="sm"
                :required="fields[fieldId]?.required"
              />
              <p v-if="fields[fieldId]?.description" class="mb-1 text-xs text-muted">
                {{ fields[fieldId].description }}
              </p>
              <div class="mt-1.5">
                <AtomsContentFieldEditor
                  :type="fields[fieldId]?.type ?? 'string'"
                  :model-value="batchEditData[fieldId]"
                  :field-id="fieldId"
                  :field-def="fields[fieldId]"
                  :options="fields[fieldId]?.options"
                  :related-entries="relationEntriesMap[fieldId]"
                  :standalone="false"
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
        <div class="flex shrink-0 items-center justify-between border-t border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <div>
            <AtomsBadge v-if="dirtyFieldCount > 0" variant="info" size="sm">
              {{ t('content.dirty_count', { count: dirtyFieldCount }) }}
            </AtomsBadge>
          </div>
          <div class="flex items-center gap-2">
            <AtomsBaseButton size="sm" :disabled="saving" @click="handleClose">
              <span>{{ t('common.cancel') }}</span>
            </AtomsBaseButton>
            <AtomsBaseButton
              variant="primary"
              size="sm"
              :disabled="saving || !hasBatchChanges"
              @click="handleSave"
            >
              <span>{{ saving ? t('common.connecting') : t('content.save_all') }}</span>
            </AtomsBaseButton>
          </div>
        </div>

        <!-- Server error -->
        <div v-if="saveError" class="border-t border-danger-200 bg-error px-6 py-3 dark:border-danger-800 dark:bg-danger-950">
          <p class="text-xs text-danger-600 dark:text-danger-400">
            {{ saveError }}
          </p>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
