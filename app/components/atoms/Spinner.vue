<script setup lang="ts">
withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg'
  label?: string
}>(), {
  size: 'md',
  label: undefined,
})

const sizeClasses: Record<string, string> = {
  sm: 'size-4',
  md: 'size-6',
  lg: 'size-8',
}
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3">
    <div
      class="animate-spin rounded-full border-2 border-secondary-200 border-t-primary-500 dark:border-secondary-800 dark:border-t-primary-400"
      :class="sizeClasses[size]"
      role="status"
    >
      <span class="sr-only">{{ label ?? 'Loading' }}</span>
    </div>
    <p v-if="label" class="text-sm text-muted">
      {{ label }}
    </p>
  </div>
</template>
