<script setup lang="ts">
const props = withDefaults(defineProps<{
  src?: string | null
  name?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg'
}>(), {
  src: null,
  name: null,
  size: 'md',
})

const initials = computed(() => {
  if (!props.name) return '?'
  return props.name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
})

const sizeClasses: Record<string, string> = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-12 text-base',
}
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary-100 font-medium text-secondary-600 dark:bg-secondary-800 dark:text-secondary-300"
    :class="sizeClasses[size]"
  >
    <NuxtImg
      v-if="src"
      :src="src"
      :alt="name ?? ''"
      class="size-full object-cover"
    />
    <span v-else aria-hidden="true">{{ initials }}</span>
  </span>
</template>
