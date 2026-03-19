<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'line' | 'card' | 'avatar' | 'custom'
  width?: string
  height?: string
  rounded?: string
}>(), {
  variant: 'line',
  width: undefined,
  height: undefined,
  rounded: undefined,
})

const variantClasses: Record<string, string> = {
  line: 'h-4 w-full rounded',
  card: 'h-32 w-full rounded-xl',
  avatar: 'size-10 rounded-full',
  custom: '',
}
</script>

<template>
  <div
    class="animate-pulse bg-secondary-100 dark:bg-secondary-800"
    :class="variantClasses[variant]"
    :style="{
      width: width ?? undefined,
      height: height ?? undefined,
      borderRadius: rounded ?? undefined,
    }"
  />
</template>
