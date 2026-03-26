<script setup lang="ts">
const {
  modelValue = '',
  placeholder = '',
  disabled = false,
  rows = 4,
  state = 'default',
  autoResize = false,
  name,
} = defineProps<{
  modelValue?: string
  placeholder?: string
  disabled?: boolean
  rows?: number
  state?: 'default' | 'error' | 'success'
  autoResize?: boolean
  name?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)

const stateClasses: Record<string, string> = {
  default: 'border-secondary-200 dark:border-secondary-800 focus:border-primary-500',
  error: 'border-danger-500 focus:border-danger-500 focus:ring-danger-500/30',
  success: 'border-success-500 focus:border-success-500 focus:ring-success-500/30',
}

function handleInput(e: Event) {
  const target = e.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)

  if (autoResize) {
    target.style.height = 'auto'
    target.style.height = `${Math.min(target.scrollHeight, 320)}px`
  }
}

defineExpose({ textareaRef })
</script>

<template>
  <textarea
    ref="textareaRef" :value="modelValue" :name="name" :placeholder="placeholder" :disabled="disabled" :rows="rows"
    class="w-full rounded-lg border bg-white px-3 py-2 text-sm text-secondary-900 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-secondary-900 dark:text-secondary-100"
    :class="[stateClasses[state], autoResize ? 'resize-none' : 'resize-y']" @input="handleInput"
  />
</template>
