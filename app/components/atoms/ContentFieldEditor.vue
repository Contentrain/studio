<script setup lang="ts">
import { isPolymorphicRelation, relationItemKey, relationKeyToItem } from '~/utils/content-relations'

interface FieldDef {
  type: string
  required?: boolean
  default?: unknown
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

// --- Relations (single + multi, with polymorphic { model, ref } support) ---
// Per MCP validator: a relation/relations field whose `model` lists more than
// one target stores compound `{ model, ref }` values instead of bare strings.
// Encoding/normalization lives in ~/utils/content-relations (unit-tested).
const isPolymorphic = computed(() => isPolymorphicRelation(fieldDef?.model))
const relItemKey = relationItemKey

function relKeyToItem(key: string): unknown {
  return relationKeyToItem(key, isPolymorphic.value)
}

const newRelationValue = ref('')

// Multi-select add dropdown — hide entries already selected.
const availableRelationOptions = computed(() => {
  if (!relatedEntries) return []
  const selected = new Set(
    Array.isArray(localValue.value) ? (localValue.value as unknown[]).map(relItemKey) : [],
  )
  return relatedEntries.filter(e => !selected.has(e.value))
})

function addRelation(key: string) {
  if (!key) return
  const item = relKeyToItem(key)
  const arr = Array.isArray(localValue.value) ? [...localValue.value as unknown[]] : []
  if (!arr.some(x => relItemKey(x) === relItemKey(item))) arr.push(item)
  localValue.value = arr
}

// Manual entry fallback when the target model's entries aren't available.
function addManualRelation() {
  const trimmed = newRelationValue.value.trim()
  if (!trimmed) return
  addRelation(trimmed)
  newRelationValue.value = ''
}

function removeRelation(index: number) {
  const arr = Array.isArray(localValue.value) ? [...localValue.value as unknown[]] : []
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

// --- Array of objects (repeater) ---
// Per Contentrain §7.2, `array` items may be `{ type: 'object', fields }`. This
// is a first-class, MCP-validated pattern (validator recurses into item fields),
// so the form edits it inline as a repeater of object rows rather than punting
// to the chat-only placeholder.
const arrayItemFields = computed<Record<string, FieldDef>>(() => {
  const items = fieldDef?.items
  if (type === 'array' && items !== null && typeof items === 'object' && items.type === 'object' && items.fields) {
    return items.fields
  }
  return {}
})
const arrayItemFieldIds = computed(() => Object.keys(arrayItemFields.value))
const isObjectArray = computed(() => arrayItemFieldIds.value.length > 0)
const arrayItems = computed(() => (Array.isArray(localValue.value) ? localValue.value : []) as Array<Record<string, unknown>>)

function addArrayObject() {
  const arr = [...arrayItems.value]
  const item: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(arrayItemFields.value)) {
    item[key] = def.default ?? null
  }
  arr.push(item)
  localValue.value = arr
}

function removeArrayObject(index: number) {
  const arr = [...arrayItems.value]
  arr.splice(index, 1)
  localValue.value = arr
}

function getArrayObjectField(index: number, key: string): unknown {
  return arrayItems.value[index]?.[key] ?? null
}

function updateArrayObjectField(index: number, key: string, value: unknown) {
  const arr = [...arrayItems.value]
  arr[index] = { ...arr[index], [key]: value }
  localValue.value = arr
}

// Relation entries label lookup (key is the option-value form).
function getRelationLabel(key: string): string {
  return relatedEntries?.find(e => e.value === key)?.label ?? key.substring(0, 8)
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
        aria-label="Color picker"
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

    <!-- ═══ Markdown / Richtext → source editor (toolbar + preview) ═══ -->
    <MoleculesMarkdownEditor
      v-else-if="['markdown', 'richtext'].includes(type)"
      :model-value="String(localValue ?? '')"
      @update:model-value="localValue = $event"
    />

    <!-- ═══ Text / Code ═══ -->
    <AtomsFormTextarea
      v-else-if="['text', 'code'].includes(type)"
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

    <!-- ═══ Date ═══
         Converted in both directions: the input only accepts YYYY-MM-DD and
         silently blanks anything else, and writing its raw output back would
         drop the stored ISO shape. See app/utils/date-field.ts. -->
    <AtomsFormInput
      v-else-if="type === 'date'"
      :model-value="toDateInputValue(localValue)"
      type="date"
      @update:model-value="localValue = fromDateInputValue($event)"
      @keydown="handleKeydown"
    />

    <!-- ═══ Datetime ═══ -->
    <AtomsFormInput
      v-else-if="type === 'datetime'"
      :model-value="toDateTimeInputValue(localValue)"
      type="datetime-local"
      @update:model-value="localValue = fromDateTimeInputValue($event)"
      @keydown="handleKeydown"
    />

    <!-- ═══ Image / Video / File (media picker) ═══ -->
    <MoleculesImageFieldPicker
      v-else-if="['image', 'video', 'file'].includes(type)"
      :model-value="String(localValue ?? '')"
      @update:model-value="localValue = $event ?? ''"
    />

    <!-- ═══ Relation (single select) ═══ -->
    <AtomsFormSelect
      v-else-if="type === 'relation' && relatedEntries && relatedEntries.length > 0"
      :model-value="relItemKey(localValue)"
      :options="relatedEntries"
      :placeholder="t('content.select_entry')"
      size="md"
      @update:model-value="localValue = relKeyToItem($event)"
    />
    <AtomsFormInput
      v-else-if="type === 'relation'"
      :model-value="isPolymorphic ? '' : String(localValue ?? '')"
      :placeholder="t('content.select_entry')"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- ═══ Relations (multi-select) ═══ -->
    <div v-else-if="type === 'relations'">
      <div v-if="Array.isArray(localValue) && (localValue as unknown[]).length > 0" class="mb-2 flex flex-wrap gap-1">
        <span
          v-for="(item, idx) in (localValue as unknown[])"
          :key="relItemKey(item)"
          class="inline-flex items-center gap-1 rounded-full bg-secondary-100 px-2 py-0.5 text-xs font-medium text-heading dark:bg-secondary-800 dark:text-secondary-100"
        >
          {{ getRelationLabel(relItemKey(item)) }}
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
        v-if="availableRelationOptions.length > 0"
        model-value=""
        :options="availableRelationOptions"
        :placeholder="t('content.select_entry')"
        size="md"
        @update:model-value="addRelation($event)"
      />
      <div
        v-else-if="!relatedEntries || relatedEntries.length === 0"
        class="flex items-center gap-2"
      >
        <AtomsFormInput
          v-model="newRelationValue"
          :placeholder="t('content.select_entry')"
          @keydown.enter.prevent="addManualRelation"
        />
        <AtomsBaseButton size="sm" @click="addManualRelation">
          <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
        </AtomsBaseButton>
      </div>
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

    <!-- ═══ Array of objects (repeater, max depth 2) ═══ -->
    <div v-else-if="type === 'array' && isObjectArray && depth < 2" class="space-y-2">
      <div
        v-for="(item, idx) in arrayItems"
        :key="idx"
        class="space-y-3 rounded-lg border border-secondary-200 p-3 dark:border-secondary-800"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-muted">#{{ idx + 1 }}</span>
          <button
            type="button"
            class="rounded-md p-1 text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :aria-label="t('common.remove')"
            @click="removeArrayObject(idx)"
          >
            <span class="icon-[annon--trash] block size-3.5" aria-hidden="true" />
          </button>
        </div>
        <div v-for="key in arrayItemFieldIds" :key="key">
          <AtomsFormLabel :text="key" size="xs" :required="arrayItemFields[key]?.required" />
          <div class="mt-1">
            <AtomsContentFieldEditor
              :type="arrayItemFields[key]?.type ?? 'string'"
              :model-value="getArrayObjectField(idx, key)"
              :field-id="`${fieldId}[${idx}].${key}`"
              :field-def="arrayItemFields[key]"
              :options="arrayItemFields[key]?.options"
              :standalone="false"
              :depth="depth + 1"
              @update:model-value="updateArrayObjectField(idx, key, $event)"
            />
          </div>
        </div>
      </div>
      <AtomsBaseButton size="sm" @click="addArrayObject">
        <template #prepend>
          <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
        </template>
        <span>{{ t('content.add_item') }}</span>
      </AtomsBaseButton>
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
