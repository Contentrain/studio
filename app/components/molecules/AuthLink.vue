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
      class="text-sm font-medium text-primary-500 hover:underline dark:text-primary-400"
    >
      {{ label }}
    </NuxtLink>
  </div>
</template>
