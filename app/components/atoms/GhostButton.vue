<script lang="ts" setup>
import { Primitive } from 'radix-vue'

interface Props {
  block?: boolean
  disabled?: boolean
  size?: 'sm' | 'md' | 'lg'
}

withDefaults(defineProps<Props>(), {
  block: false,
  disabled: false,
  size: 'md',
})
</script>

<template>
  <Primitive
    as="button"
    :disabled="disabled"
    class="inline-flex items-center justify-center gap-2 rounded-lg border border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 font-medium text-secondary-900 dark:text-secondary-100 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-800 disabled:cursor-not-allowed disabled:opacity-50"
    :class="[
      block ? 'w-full' : '',
      {
        'px-3 py-1.5 text-sm': size === 'sm',
        'px-4 py-2.5 text-sm': size === 'md',
        'px-5 py-3 text-base': size === 'lg',
      },
    ]"
  >
    <span v-if="$slots.prepend" class="shrink-0">
      <slot name="prepend" />
    </span>
    <slot />
    <span v-if="$slots.append" class="shrink-0">
      <slot name="append" />
    </span>
  </Primitive>
</template>
