<script setup lang="ts">
withDefaults(defineProps<{
  icon: string
  label?: string
  size?: 'sm' | 'md'
  type?: 'button' | 'submit' | 'reset'
}>(), {
  label: undefined,
  size: 'md',
  type: 'button',
})

const sizeClasses: Record<string, string> = {
  sm: 'p-0.5',
  md: 'p-1',
}
</script>

<template>
  <button
    :type="type"
    class="shrink-0 rounded text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900 dark:hover:text-secondary-100"
    :class="sizeClasses[size]"
  >
    <span :class="[icon, size === 'sm' ? 'block size-3' : 'block size-4']" aria-hidden="true" />
    <span class="sr-only">{{ label }}</span>
  </button>
</template>
