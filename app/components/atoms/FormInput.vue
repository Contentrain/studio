<script lang="ts" setup>
interface Props {
  modelValue?: string
  type?: 'text' | 'email' | 'password' | 'url' | 'search'
  placeholder?: string
  disabled?: boolean
  required?: boolean
  id?: string
  name?: string
  state?: 'default' | 'error' | 'success'
  description?: string
}

withDefaults(defineProps<Props>(), {
  modelValue: '',
  type: 'text',
  placeholder: '',
  disabled: false,
  required: false,
  state: 'default',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function onInput(event: Event) {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', target.value)
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <input
      :id="id"
      :type="type"
      :name="name"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      :aria-invalid="state === 'error'"
      :aria-describedby="description && id ? `${id}-description` : undefined"
      class="w-full rounded-lg border px-3 py-2 text-sm bg-white dark:bg-secondary-900 text-secondary-900 dark:text-secondary-100 placeholder:text-muted transition-colors outline-none focus:ring-2 focus:ring-primary-500/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:text-secondary-300 dark:disabled:text-secondary-600"
      :class="{
        'border-secondary-200 dark:border-secondary-800 focus:border-primary-500': state === 'default',
        'border-danger-500 focus:border-danger-500 focus:ring-danger-500/30': state === 'error',
        'border-success-500 focus:border-success-500 focus:ring-success-500/30': state === 'success',
      }"
      @input="onInput"
    >
    <p
      v-if="description"
      :id="id ? `${id}-description` : undefined"
      class="text-xs"
      :class="{
        'text-muted': state === 'default',
        'text-danger-500': state === 'error',
        'text-success-500': state === 'success',
      }"
    >
      {{ description }}
    </p>
  </div>
</template>
