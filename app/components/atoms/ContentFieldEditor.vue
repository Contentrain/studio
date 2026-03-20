<script setup lang="ts">
const { t } = useContent()

/**
 * Inline field editor — uses atom components for each field type.
 * Companion to ContentFieldDisplay (read mode).
 */
const {
  type,
  modelValue,
  options,
  saving = false,
} = defineProps<{
  type: string
  modelValue: unknown
  fieldId: string
  options?: string[]
  saving?: boolean
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

const isStringType = computed(() => ['string', 'email', 'url', 'slug', 'phone', 'icon', 'color'].includes(type))
const isTextType = computed(() => ['text', 'markdown', 'richtext', 'code'].includes(type))
const isNumberType = computed(() => ['number', 'integer', 'decimal', 'percent', 'rating'].includes(type))

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    emit('save')
  }
  if (e.key === 'Escape') {
    emit('cancel')
  }
}

const inputType = computed(() => {
  if (type === 'email') return 'email'
  if (type === 'url') return 'url'
  if (type === 'color') return 'color'
  return 'text'
})
</script>

<template>
  <div class="space-y-2">
    <!-- String types -->
    <AtomsFormInput
      v-if="isStringType"
      :model-value="String(localValue ?? '')"
      :type="inputType"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- Text / Markdown / Richtext / Code -->
    <AtomsFormTextarea
      v-else-if="isTextType"
      :model-value="String(localValue ?? '')"
      :rows="4"
      @update:model-value="localValue = $event"
      @keydown.escape="emit('cancel')"
    />

    <!-- Number types -->
    <AtomsFormInput
      v-else-if="isNumberType"
      :model-value="String(localValue ?? '')"
      type="number"
      @update:model-value="localValue = Number($event)"
      @keydown="handleKeydown"
    />

    <!-- Boolean -->
    <AtomsFormSwitch
      v-else-if="type === 'boolean'"
      :model-value="!!localValue"
      :label="localValue ? 'Yes' : 'No'"
      @update:model-value="localValue = $event"
    />

    <!-- Date -->
    <AtomsFormInput
      v-else-if="type === 'date'"
      :model-value="String(localValue ?? '')"
      type="date"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- Datetime -->
    <AtomsFormInput
      v-else-if="type === 'datetime'"
      :model-value="String(localValue ?? '')"
      type="datetime-local"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- Select -->
    <AtomsFormSelect
      v-else-if="type === 'select' && options"
      :model-value="String(localValue ?? '')"
      :options="options"
      size="md"
      @update:model-value="localValue = $event"
    />

    <!-- Fallback -->
    <AtomsFormInput
      v-else
      :model-value="String(localValue ?? '')"
      @update:model-value="localValue = $event"
      @keydown="handleKeydown"
    />

    <!-- Action buttons -->
    <div class="flex items-center gap-1.5">
      <AtomsBaseButton variant="primary" size="sm" :disabled="saving" @click="emit('save')">
        <span>{{ saving ? t('common.connecting') : t('common.save_changes') }}</span>
      </AtomsBaseButton>
      <AtomsBaseButton size="sm" :disabled="saving" @click="emit('cancel')">
        <span>{{ t('common.cancel') }}</span>
      </AtomsBaseButton>
    </div>
  </div>
</template>
