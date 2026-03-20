<script setup lang="ts">
/**
 * Inline field editor — type-specific input for each of 27 field types.
 * Companion to ContentFieldDisplay (read mode).
 */
const props = defineProps<{
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
  get: () => props.modelValue,
  set: (v: unknown) => emit('update:modelValue', v),
})

const inputClass = 'w-full rounded-md border border-primary-300 bg-white px-3 py-1.5 text-sm text-heading focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-primary-700 dark:bg-secondary-900 dark:text-secondary-100'

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    emit('save')
  }
  if (e.key === 'Escape') {
    emit('cancel')
  }
}
</script>

<template>
  <div class="space-y-2">
    <!-- String types -->
    <input
      v-if="['string', 'email', 'url', 'slug', 'phone', 'icon', 'color'].includes(type)"
      v-model="localValue"
      :type="type === 'email' ? 'email' : type === 'url' ? 'url' : type === 'color' ? 'color' : 'text'"
      :class="inputClass"
      @keydown="handleKeydown"
    >

    <!-- Text / Markdown / Richtext / Code -->
    <textarea
      v-else-if="['text', 'markdown', 'richtext', 'code'].includes(type)"
      v-model="localValue"
      rows="4"
      :class="[inputClass, 'resize-y']"
      @keydown.escape="emit('cancel')"
    />

    <!-- Number types -->
    <input
      v-else-if="['number', 'integer', 'decimal', 'percent', 'rating'].includes(type)"
      v-model.number="localValue"
      type="number"
      :step="type === 'integer' || type === 'rating' ? '1' : '0.01'"
      :min="type === 'percent' ? '0' : type === 'rating' ? '1' : undefined"
      :max="type === 'percent' ? '100' : type === 'rating' ? '5' : undefined"
      :class="inputClass"
      @keydown="handleKeydown"
    >

    <!-- Boolean -->
    <label v-else-if="type === 'boolean'" class="flex items-center gap-2">
      <input
        v-model="localValue"
        type="checkbox"
        class="size-4 rounded border-secondary-300 text-primary-600 focus:ring-primary-500 dark:border-secondary-600"
      >
      <span class="text-sm text-heading dark:text-secondary-100">{{ localValue ? 'Yes' : 'No' }}</span>
    </label>

    <!-- Date / Datetime -->
    <input
      v-else-if="type === 'date'"
      v-model="localValue"
      type="date"
      :class="inputClass"
      @keydown="handleKeydown"
    >
    <input
      v-else-if="type === 'datetime'"
      v-model="localValue"
      type="datetime-local"
      :class="inputClass"
      @keydown="handleKeydown"
    >

    <!-- Select -->
    <select
      v-else-if="type === 'select' && options"
      v-model="localValue"
      :class="inputClass"
    >
      <option v-for="opt in options" :key="opt" :value="opt">
        {{ opt }}
      </option>
    </select>

    <!-- Fallback: text input -->
    <input
      v-else
      v-model="localValue"
      type="text"
      :class="inputClass"
      @keydown="handleKeydown"
    >

    <!-- Action buttons -->
    <div class="flex items-center gap-1.5">
      <AtomsBaseButton
        variant="primary"
        size="sm"
        :disabled="saving"
        @click="emit('save')"
      >
        <span>{{ saving ? 'Saving...' : 'Save' }}</span>
      </AtomsBaseButton>
      <AtomsBaseButton
        size="sm"
        :disabled="saving"
        @click="emit('cancel')"
      >
        <span>Cancel</span>
      </AtomsBaseButton>
    </div>
  </div>
</template>
