<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'secondary'
  size?: 'sm' | 'md'
}>(), {
  variant: 'secondary',
  size: 'sm',
})

const variantClasses: Record<string, string> = {
  primary: 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400',
  success: 'bg-success-100 text-success-700 dark:bg-success-900/30 dark:text-success-400',
  warning: 'bg-warning-100 text-warning-700 dark:bg-warning-900/30 dark:text-warning-400',
  danger: 'bg-danger-100 text-danger-700 dark:bg-danger-900/30 dark:text-danger-400',
  info: 'bg-info-100 text-info-700 dark:bg-info-900/30 dark:text-info-400',
  secondary: 'bg-secondary-100 text-secondary-600 dark:bg-secondary-800 dark:text-secondary-400',
}

const sizeClasses: Record<string, string> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
}
</script>

<template>
  <span
    class="inline-flex items-center rounded-full font-medium leading-none"
    :class="[variantClasses[variant], sizeClasses[size]]"
  >
    <slot />
  </span>
</template>
