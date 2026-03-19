<script setup lang="ts">
withDefaults(defineProps<{
  label: string
  count?: number | null
}>(), {
  count: null,
})
</script>

<template>
  <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
    <span>{{ label }}</span>
    <span v-if="count !== null" class="tabular-nums text-disabled">{{ count }}</span>
    <slot />
  </div>
</template>
