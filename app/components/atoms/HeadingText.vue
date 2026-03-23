<script lang="ts" setup>
interface Props {
  /** Semantic heading level (h1-h6) */
  level?: 1 | 2 | 3 | 4 | 5 | 6
  /** Visual size — independent from semantic level */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'
  /** Render as different element (default: h{level}) */
  as?: string
  /** Truncate long text with ellipsis */
  truncate?: boolean
  /** Font weight override */
  weight?: 'medium' | 'semibold' | 'bold'
}

const props = withDefaults(defineProps<Props>(), {
  level: 3,
  size: '2xl',
  as: undefined,
  truncate: false,
  weight: 'semibold',
})

const tag = computed(() => props.as ?? `h${props.level}`)

const sizeClass = computed(() => ({
  'xs': 'text-sm',
  'sm': 'text-base',
  'md': 'text-lg',
  'lg': 'text-xl',
  'xl': 'text-2xl',
  '2xl': 'text-3xl',
  '3xl': 'text-4xl',
}[props.size]))

const weightClass = computed(() => ({
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
}[props.weight]))
</script>

<template>
  <component
    :is="tag"
    class="font-display tracking-tight text-secondary-900 dark:text-secondary-100"
    :class="[sizeClass, weightClass, { truncate: truncate }]"
  >
    <slot />
  </component>
</template>
