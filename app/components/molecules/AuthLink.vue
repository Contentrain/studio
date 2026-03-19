<script lang="ts" setup>
interface Props {
  label: string
  description: string
  to: string
}

defineProps<Props>()
</script>

<template>
  <div class="pt-6 text-center">
    <p class="mb-2 text-sm text-muted">
      {{ description }}
    </p>
    <NuxtLink
      :to="to"
      class="rounded text-sm font-medium text-primary-500 hover:underline dark:text-primary-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
    >
      {{ label }}
    </NuxtLink>
  </div>
</template>
