<script setup lang="ts">
defineProps<{
  text: string
}>()
</script>

<template>
  <AtomsTooltip :text="text">
    <button
      type="button"
      :aria-label="text"
      class="inline-flex shrink-0 rounded-full p-0.5 text-muted transition-colors hover:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
    >
      <span class="icon-[annon--info] size-3.5" aria-hidden="true" />
    </button>
  </AtomsTooltip>
</template>
