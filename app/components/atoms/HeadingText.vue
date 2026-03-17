<script lang="ts" setup>
interface Props {
  level?: 1 | 2 | 3 | 4 | 5 | 6
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'
}

const props = withDefaults(defineProps<Props>(), {
  level: 3,
  size: '2xl',
})

const tag = computed(() => `h${props.level}`)

const sizeClass = computed(() => ({
  'sm': 'text-base',
  'md': 'text-lg',
  'lg': 'text-xl',
  'xl': 'text-2xl',
  '2xl': 'text-3xl',
  '3xl': 'text-4xl',
}[props.size]))
</script>

<template>
  <component
    :is="tag"
    class="font-medium tracking-tight text-secondary-900 dark:text-secondary-100"
    :class="sizeClass"
  >
    <slot />
  </component>
</template>
