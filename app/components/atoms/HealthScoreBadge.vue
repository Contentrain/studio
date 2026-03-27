<script setup lang="ts">
const props = withDefaults(defineProps<{
  score: number
  size?: 'sm' | 'md'
}>(), {
  size: 'sm',
})

const variant = computed(() => {
  if (props.score >= 90) return 'success'
  if (props.score >= 70) return 'warning'
  return 'danger'
})

const variantClasses: Record<string, string> = {
  success: 'bg-success-100 text-success-700 dark:bg-success-900/30 dark:text-success-400',
  warning: 'bg-warning-100 text-warning-700 dark:bg-warning-900/30 dark:text-warning-400',
  danger: 'bg-danger-100 text-danger-700 dark:bg-danger-900/30 dark:text-danger-400',
}

const sizeClasses: Record<string, string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2 py-1 text-sm',
}
</script>

<template>
  <span
    class="inline-flex items-center justify-center rounded-full font-semibold leading-none tabular-nums"
    :class="[variantClasses[variant], sizeClasses[size]]"
  >
    {{ score }}
  </span>
</template>
