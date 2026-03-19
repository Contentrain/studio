<script setup lang="ts">
withDefaults(defineProps<{
  image?: string
  icon?: string
  title: string
  description?: string
}>(), {
  image: undefined,
  icon: undefined,
  description: undefined,
})
</script>

<template>
  <div class="flex flex-col items-center py-12 text-center">
    <!-- Illustration or icon -->
    <NuxtImg
      v-if="image"
      :src="image"
      :alt="title"
      class="size-20 dark:brightness-90 dark:contrast-75 dark:hue-rotate-180 dark:invert"
    />
    <div
      v-else-if="icon"
      class="flex size-16 items-center justify-center rounded-2xl bg-secondary-50 dark:bg-secondary-900"
    >
      <span :class="[icon, 'text-2xl text-muted']" aria-hidden="true" />
    </div>

    <!-- Text -->
    <h3 class="mt-5 text-sm font-semibold text-heading dark:text-secondary-100">
      {{ title }}
    </h3>
    <p v-if="description" class="mt-1.5 max-w-xs text-sm text-muted">
      {{ description }}
    </p>

    <!-- Action slot -->
    <div v-if="$slots.action" class="mt-5">
      <slot name="action" />
    </div>
  </div>
</template>
