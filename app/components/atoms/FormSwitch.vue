<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'radix-vue'

const {
  modelValue = false,
  label,
  disabled = false,
} = defineProps<{
  modelValue?: boolean
  label?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<template>
  <label class="flex items-center gap-2">
    <SwitchRoot
      :checked="modelValue"
      :disabled="disabled"
      class="relative h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary-600 data-[state=unchecked]:bg-secondary-200 dark:data-[state=unchecked]:bg-secondary-700"
      @update:checked="emit('update:modelValue', $event)"
    >
      <SwitchThumb class="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </SwitchRoot>
    <span v-if="label" class="text-sm text-heading dark:text-secondary-100">{{ label }}</span>
  </label>
</template>
