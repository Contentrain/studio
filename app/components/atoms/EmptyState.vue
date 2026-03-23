<script setup lang="ts">
withDefaults(defineProps<{
  icon?: string
  title: string
  description?: string
}>(), {
  icon: 'icon-[annon--box]',
  description: undefined,
})
</script>

<template>
  <div class="flex flex-col items-center py-12 text-center">
    <!-- Illustration or icon -->
    <div
      v-if="icon"
      class="flex size-14 items-center justify-center rounded-2xl border border-secondary-200 bg-secondary-50 dark:border-secondary-800 dark:bg-secondary-900"
    >
      <span :class="[icon, 'text-2xl text-muted']" aria-hidden="true" />
    </div>

    <!-- Text -->
    <AtomsHeadingText :level="3" size="xs" class="mt-5">
      {{ title }}
    </AtomsHeadingText>
    <p v-if="description" class="mt-1.5 max-w-xs text-sm text-muted">
      {{ description }}
    </p>

    <!-- Action slot -->
    <div v-if="$slots.action" class="mt-5">
      <slot name="action" />
    </div>
  </div>
</template>
