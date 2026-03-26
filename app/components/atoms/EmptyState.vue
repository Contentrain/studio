<script setup lang="ts">
withDefaults(defineProps<{
  icon?: string
  illustration?: string
  title: string
  description?: string
  compact?: boolean
}>(), {
  icon: undefined,
  illustration: undefined,
  description: undefined,
  compact: false,
})
</script>

<template>
  <div class="flex flex-col items-center text-center" :class="compact ? 'py-6' : 'py-12'">
    <!-- Illustration (takes precedence over icon) -->
    <NuxtImg
      v-if="illustration"
      :src="illustration"
      :alt="title"
      class="h-28 w-auto"
      loading="lazy"
    />

    <!-- Icon fallback -->
    <div
      v-else-if="icon"
      class="flex size-14 items-center justify-center rounded-2xl border border-secondary-200 bg-secondary-50 dark:border-secondary-800 dark:bg-secondary-900"
    >
      <span :class="[icon, 'text-2xl text-muted']" aria-hidden="true" />
    </div>

    <!-- Text -->
    <AtomsHeadingText :level="3" size="xs" :class="illustration || icon ? 'mt-5' : ''">
      {{ title }}
    </AtomsHeadingText>
    <p v-if="description" class="mt-1.5 max-w-sm text-sm text-muted">
      {{ description }}
    </p>

    <!-- Action slot -->
    <div v-if="$slots.action" class="mt-5">
      <slot name="action" />
    </div>
  </div>
</template>
