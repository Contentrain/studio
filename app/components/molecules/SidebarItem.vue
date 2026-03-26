<script setup lang="ts">
withDefaults(defineProps<{
  icon?: string
  label: string
  active?: boolean
  count?: number | string | null
  compact?: boolean
  disabled?: boolean
}>(), {
  icon: undefined,
  active: false,
  count: null,
  compact: false,
  disabled: false,
})

defineEmits<{
  click: []
}>()
</script>

<template>
  <button
    type="button" :disabled="disabled"
    class="flex w-full items-center gap-2 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
    :class="[
      compact ? 'px-2 py-1 text-[13px]' : 'px-2 py-1.5 text-sm',
      disabled
        ? 'cursor-not-allowed text-disabled'
        : active
          ? 'border-l-2 border-primary-500 bg-primary-50 pl-1.5 text-primary-700 font-medium dark:bg-primary-900/20 dark:text-primary-400'
          : 'text-body hover:bg-primary-50 hover:text-primary-700 dark:text-secondary-400 dark:hover:bg-primary-900/20 dark:hover:text-primary-400',
    ]" @click="!disabled && $emit('click')"
  >
    <span
      v-if="icon" :class="[icon, compact ? 'size-3.5' : 'size-4']" class="shrink-0"
      :style="{ opacity: disabled ? '0.4' : active ? '1' : '0.6' }" aria-hidden="true"
    />
    <span class="min-w-0 flex-1 truncate">{{ label }}</span>
    <slot name="trailing" />
    <span v-if="count !== null" class="shrink-0 text-[10px] tabular-nums text-disabled">
      {{ count }}
    </span>
  </button>
</template>
