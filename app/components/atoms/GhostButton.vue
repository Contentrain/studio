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
    class="inline-flex items-center justify-center gap-2 rounded-lg border border-[--color-border-default] bg-[--color-surface] font-medium text-[--color-heading] transition-colors hover:bg-[--color-surface-raised] disabled:cursor-not-allowed disabled:opacity-50"
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
