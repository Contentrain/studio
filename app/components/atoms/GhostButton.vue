<script lang="ts" setup>
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
  <button
    :disabled="disabled"
    class="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 font-medium text-gray-700 dark:text-gray-200 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
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
  </button>
</template>
