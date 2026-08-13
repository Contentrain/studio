<script setup lang="ts">
import { SelectContent, SelectItem, SelectItemText, SelectPortal, SelectRoot, SelectTrigger, SelectValue, SelectViewport } from 'radix-vue'

const {
  modelValue = '',
  options,
  placeholder = '',
  size = 'md',
  variant = 'default',
  label = undefined,
} = defineProps<{
  modelValue?: string
  options: Array<string | { value: string, label: string }>
  placeholder?: string
  size?: 'sm' | 'md'
  /** `ghost` drops the chrome — for selects that sit inside another card. */
  variant?: 'default' | 'ghost'
  /** Accessible name; the trigger otherwise announces only its value. */
  label?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const normalizedOptions = computed(() =>
  options.map(opt =>
    typeof opt === 'string' ? { value: opt, label: opt } : opt,
  ),
)

const sizeClasses: Record<string, string> = {
  sm: 'h-7 min-w-14 px-2 text-xs',
  md: 'h-9 px-3 text-sm',
}

const variantClasses: Record<string, string> = {
  default: 'border-secondary-200 bg-white hover:bg-secondary-50 dark:border-secondary-700 dark:bg-secondary-800 dark:hover:bg-secondary-700',
  ghost: 'border-transparent bg-transparent hover:bg-secondary-100 dark:hover:bg-secondary-800',
}
</script>

<template>
  <SelectRoot :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <SelectTrigger
      :aria-label="label"
      class="inline-flex items-center justify-between gap-1.5 rounded-lg border font-medium text-heading transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-secondary-100"
      :class="[sizeClasses[size], variantClasses[variant]]"
    >
      <SelectValue :placeholder="placeholder" />
      <span class="icon-[annon--chevron-down] size-3 shrink-0 text-muted" aria-hidden="true" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper" :side-offset="4"
        class="z-50 max-h-60 min-w-32 overflow-hidden rounded-lg border border-secondary-200 bg-white shadow-lg dark:border-secondary-800 dark:bg-secondary-950"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="opt in normalizedOptions" :key="opt.value" :value="opt.value"
            class="flex items-center rounded-md px-2 py-1.5 text-sm text-heading outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-500/50 data-highlighted:bg-secondary-50 dark:text-secondary-100 dark:data-highlighted:bg-secondary-900"
          >
            <SelectItemText>{{ opt.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
