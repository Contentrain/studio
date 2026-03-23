<script setup lang="ts">
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

/**
 * Field editor — type-aware atom for editing content fields.
 * Supports all 27 Contentrain field types.
 * Use standalone=true for inline editing, standalone=false inside modals.
 */
const {
  type,
  modelValue,
  fieldId,
  options,
  saving = false,
  standalone = true,
  fieldDef,
  relatedEntries,
  depth = 0,
} = defineProps<{
  type: string
  modelValue: unknown
  fieldId: string
  options?: string[]
  saving?: boolean
  standalone?: boolean
  fieldDef?: FieldDef
  relatedEntries?: Array<{ value: string, label: string }>
  depth?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: unknown]
  'save': []
  'cancel': []
}>()

const localValue = computed({
  get: () => modelValue,
  set: (v: unknown) => emit('update:modelValue', v),
})

// --- Tag/array input ---
const newTagValue = ref('')

function addTag() {
  const trimmed = newTagValue.value.trim()
  if (!trimmed) return
  const arr = Array.isArray(localValue.value) ? [...localValue.value as unknown[]] : []
  arr.push(trimmed)
  localValue.value = arr
  newTagValue.value = ''
}

function removeTag(index: number) {
  const arr = Array.isArray(localValue.value) ? [...localValue.value as unknown[]] : []
  arr.splice(index, 1)
  localValue.value = arr
}

// --- Relations multi-select ---
function addRelation(id: string) {
  if (!id) return
  const arr = Array.isArray(localValue.value) ? [...localValue.value as string[]] : []
  if (!arr.includes(id)) arr.push(id)
  localValue.value = arr
}

function removeRelation(index: number) {
  const arr = Array.isArray(localValue.value) ? [...localValue.value as string[]] : []
  arr.splice(index, 1)
  localValue.value = arr
}

// --- Slug auto-transform ---
function handleSlugInput(val: string) {
  localValue.value = val.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

// --- Keyboard ---
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    emit('save')
  }
  if (e.key === 'Escape') {
    emit('cancel')
  }
}

// --- Type classification ---
const inputType = computed(() => {
  if (type === 'email') return 'email'
  if (type === 'url') return 'url'
  if (type === 'phone') return 'tel'
  return 'text'
})

// --- Object nested fields ---
const objectFieldIds = computed(() => {
  if (type !== 'object' || !fieldDef?.fields) return []
  return Object.keys(fieldDef.fields)
})

function getObjectFieldValue(key: string): unknown {
  const obj = (localValue.value ?? {}) as Record<string, unknown>
  return obj[key] ?? null
}

function updateObjectField(key: string, value: unknown) {
  const obj = { ...(localValue.value ?? {}) as Record<string, unknown> }
  obj[key] = value
  localValue.value = obj
}

// Relation entries label lookup
function getRelationLabel(id: string): string {
  return relatedEntries?.find(e => e.value === id)?.label ?? id.substring(0, 8)
}
</script>

<template>
  <div class="space-y-2">
    <!-- ═══ String (standard) ═══ -->
    <AtomsFormInput
      v-if="['string', 'email', 'url', 'phone', 'icon'].includes(type)"
      :model-value="String(localValue ?? '')"
      :type="inputType"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- ═══ Slug ═══ -->
    <AtomsFormInput
      v-else-if="type === 'slug'"
      :model-value="String(localValue ?? '')"
      :description="t('content.slug_hint')"
      @update:model-value="handleSlugInput($event)"
      @keydown="handleKeydown"
    />

    <!-- ═══ Color ═══ -->
    <div v-else-if="type === 'color'" class="flex items-center gap-2">
      <input
        type="color"
        :value="String(localValue ?? '#000000')"
        class="size-9 shrink-0 cursor-pointer rounded-lg border border-secondary-200 bg-white p-0.5 dark:border-secondary-800 dark:bg-secondary-900"
        @input="localValue = ($event.target as HTMLInputElement).value"
      >
      <AtomsFormInput
        :model-value="String(localValue ?? '')"
        placeholder="#000000"
        @update:model-value="localValue = $event"
        @keydown="handleKeydown"
      />
    </div>

    <!-- ═══ Text / Markdown / Richtext / Code ═══ -->
    <AtomsFormTextarea
      v-else-if="['text', 'markdown', 'richtext', 'code'].includes(type)"
      :model-value="String(localValue ?? '')"
      :rows="type === 'code' ? 6 : 4"
      :class="type === 'code' ? 'font-mono text-xs' : ''"
      @update:model-value="localValue = $event"
      @keydown.escape="emit('cancel')"
    />

    <!-- ═══ Number / Integer / Decimal ═══ -->
    <AtomsFormInput
      v-else-if="['number', 'integer', 'decimal'].includes(type)"
      :model-value="String(localValue ?? '')"
      type="number"
      @update:model-value="localValue = Number($event)"
      @keydown="handleKeydown"
    />

    <!-- ═══ Percent ═══ -->
    <div v-else-if="type === 'percent'" class="flex items-center gap-2">
      <AtomsFormInput
        :model-value="String(localValue ?? '')"
        type="number"
        @update:model-value="localValue = Math.min(100, Math.max(0, Number($event)))"
        @keydown="handleKeydown"
      />
      <span class="shrink-0 text-sm font-medium text-muted">%</span>
    </div>

    <!-- ═══ Rating (1-5 stars) ═══ -->
    <div v-else-if="type === 'rating'" class="flex items-center gap-1">
      <button
        v-for="star in 5"
        :key="star"
        type="button"
        class="p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
        @click="localValue = star"
      >
        <span
          class="text-lg"
          :class="star <= (Number(localValue) || 0) ? 'text-warning-400' : 'text-secondary-200 dark:text-secondary-700'"
        >★</span>
      </button>
      <span class="ml-1 text-xs text-muted">{{ Number(localValue) || 0 }}/5</span>
    </div>

    <!-- ═══ Boolean ═══ -->
    <AtomsFormSwitch
      v-else-if="type === 'boolean'"
      :model-value="!!localValue"
      :label="localValue ? t('common.yes') : t('common.no')"
      @update:model-value="localValue = $event"
    />

    <!-- ═══ Date ═══ -->
    <AtomsFormInput
      v-else-if="type === 'date'"
      :model-value="String(localValue ?? '')"
      type="date"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- ═══ Datetime ═══ -->
    <AtomsFormInput
      v-else-if="type === 'datetime'"
      :model-value="String(localValue ?? '')"
      type="datetime-local"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- ═══ Image / Video / File (URL/path input) ═══ -->
    <AtomsFormInput
      v-else-if="['image', 'video', 'file'].includes(type)"
      :model-value="String(localValue ?? '')"
      type="url"
      :description="t('content.enter_path')"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- ═══ Relation (single select) ═══ -->
    <AtomsFormSelect
      v-else-if="type === 'relation' && relatedEntries && relatedEntries.length > 0"
      :model-value="String(localValue ?? '')"
      :options="relatedEntries"
      :placeholder="t('content.select_entry')"
      size="md"
      @update:model-value="localValue = $event"
    />
    <AtomsFormInput
      v-else-if="type === 'relation'"
      :model-value="String(localValue ?? '')"
      :placeholder="t('content.select_entry')"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- ═══ Relations (multi-select) ═══ -->
    <div v-else-if="type === 'relations'">
      <div v-if="Array.isArray(localValue) && (localValue as string[]).length > 0" class="mb-2 flex flex-wrap gap-1">
        <span
          v-for="(id, idx) in (localValue as string[])"
          :key="id"
          class="inline-flex items-center gap-1 rounded-full bg-secondary-100 px-2 py-0.5 text-xs font-medium text-heading dark:bg-secondary-800 dark:text-secondary-100"
        >
          {{ getRelationLabel(id) }}
          <button
            type="button"
            class="ml-0.5 rounded-full p-0.5 text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            @click="removeRelation(idx)"
          >
            <span class="icon-[annon--cross] size-2.5" aria-hidden="true" />
          </button>
        </span>
      </div>
      <AtomsFormSelect
        v-if="relatedEntries && relatedEntries.length > 0"
        model-value=""
        :options="relatedEntries"
        :placeholder="t('content.select_entry')"
        size="md"
        @update:model-value="addRelation($event)"
      />
      <AtomsFormInput
        v-else
        model-value=""
        :placeholder="t('content.select_entry')"
        @keydown="handleKeydown"
      />
    </div>

    <!-- ═══ Select ═══ -->
    <AtomsFormSelect
      v-else-if="type === 'select' && (options || fieldDef?.options)"
      :model-value="String(localValue ?? '')"
      :options="options ?? fieldDef?.options ?? []"
      size="md"
      @update:model-value="localValue = $event"
    />

    <!-- ═══ Array (string[]) ═══ -->
    <div v-else-if="type === 'array' && (!fieldDef?.items || typeof fieldDef.items === 'string')">
      <div v-if="Array.isArray(localValue) && (localValue as unknown[]).length > 0" class="mb-2 flex flex-wrap gap-1">
        <span
          v-for="(item, idx) in (localValue as unknown[])"
          :key="idx"
          class="inline-flex items-center gap-1 rounded-full bg-secondary-100 px-2 py-0.5 text-xs font-medium text-heading dark:bg-secondary-800 dark:text-secondary-100"
        >
          {{ String(item) }}
          <button
            type="button"
            class="ml-0.5 rounded-full p-0.5 text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            @click="removeTag(idx)"
          >
            <span class="icon-[annon--cross] size-2.5" aria-hidden="true" />
          </button>
        </span>
      </div>
      <div class="flex items-center gap-2">
        <AtomsFormInput
          v-model="newTagValue"
          :placeholder="t('content.add_item')"
          @keydown.enter.prevent="addTag"
        />
        <AtomsBaseButton size="sm" @click="addTag">
          <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
        </AtomsBaseButton>
      </div>
    </div>

    <!-- ═══ Object (nested fields, max depth 2) ═══ -->
    <div v-else-if="type === 'object' && fieldDef?.fields && depth < 2" class="space-y-3 rounded-lg border border-secondary-200 p-3 dark:border-secondary-800">
      <div v-for="key in objectFieldIds" :key="key">
        <AtomsFormLabel :text="key" size="xs" :required="((fieldDef?.fields ?? {}) as Record<string, FieldDef>)[key]?.required" />
        <div class="mt-1">
          <AtomsContentFieldEditor
            :type="((fieldDef?.fields ?? {}) as Record<string, FieldDef>)[key]?.type ?? 'string'"
            :model-value="getObjectFieldValue(key)"
            :field-id="`${fieldId}.${key}`"
            :field-def="((fieldDef?.fields ?? {}) as Record<string, FieldDef>)[key]"
            :options="((fieldDef?.fields ?? {}) as Record<string, FieldDef>)[key]?.options"
            :standalone="false"
            :depth="depth + 1"
            @update:model-value="updateObjectField(key, $event)"
          />
        </div>
      </div>
    </div>

    <!-- ═══ Array of objects / complex — placeholder ═══ -->
    <div
      v-else-if="(type === 'array' && fieldDef?.items && typeof fieldDef.items === 'object') || (type === 'object' && depth >= 2)"
      class="rounded-lg border border-dashed border-secondary-300 px-3 py-4 text-center dark:border-secondary-700"
    >
      <span class="icon-[annon--comment-2-plus] mx-auto mb-1 block size-5 text-muted" aria-hidden="true" />
      <p class="text-xs text-muted">
        {{ t('content.complex_hint') }}
      </p>
    </div>

    <!-- ═══ Fallback ═══ -->
    <AtomsFormInput
      v-else
      :model-value="String(localValue ?? '')"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- ═══ Inline save/cancel (standalone mode only) ═══ -->
    <div v-if="standalone" class="flex items-center gap-1.5">
      <AtomsBaseButton variant="primary" size="sm" :disabled="saving" @click="emit('save')">
        <span>{{ saving ? t('common.connecting') : t('common.save_changes') }}</span>
      </AtomsBaseButton>
      <AtomsBaseButton size="sm" :disabled="saving" @click="emit('cancel')">
        <span>{{ t('common.cancel') }}</span>
      </AtomsBaseButton>
    </div>
  </div>
</template>
