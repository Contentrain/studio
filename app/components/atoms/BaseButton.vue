<script lang="ts" setup>
import { Primitive } from 'radix-vue'

interface Props {
  variant?: 'ghost' | 'primary' | 'danger' | 'secondary'
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}

withDefaults(defineProps<Props>(), {
  variant: 'ghost',
  size: 'md',
  block: false,
  disabled: false,
  type: 'button',
})

const variantClasses: Record<string, string> = {
  ghost: 'border border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 text-secondary-900 dark:text-secondary-100 hover:bg-secondary-50 dark:hover:bg-secondary-800',
  primary: 'border border-primary-600 bg-primary-600 text-white hover:bg-primary-700 hover:border-primary-700 dark:bg-primary-500 dark:border-primary-500 dark:hover:bg-primary-400 dark:hover:border-primary-400',
  danger: 'border border-danger-600 bg-danger-600 text-white hover:bg-danger-700 hover:border-danger-700 dark:bg-danger-500 dark:border-danger-500 dark:hover:bg-danger-400 dark:hover:border-danger-400',
  secondary: 'border border-transparent bg-secondary-100 dark:bg-secondary-800 text-secondary-900 dark:text-secondary-100 hover:bg-secondary-200 dark:hover:bg-secondary-700',
}

const sizeClasses: Record<string, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-base gap-2.5',
}
</script>

<template>
  <Primitive
    as="button"
    :type="type"
    :disabled="disabled"
    class="inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-50"
    :class="[
      variantClasses[variant],
      sizeClasses[size],
      block ? 'w-full' : '',
    ]"
  >
    <span v-if="$slots.prepend" class="shrink-0 flex items-center">
      <slot name="prepend" />
    </span>
    <span class="truncate">
      <slot />
    </span>
    <span v-if="$slots.append" class="shrink-0 flex items-center">
      <slot name="append" />
    </span>
  </Primitive>
</template>
