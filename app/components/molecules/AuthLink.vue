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
    <p class="mb-2 text-sm text-gray-500 dark:text-gray-400">
      {{ description }}
    </p>
    <NuxtLink
      :to="to"
      class="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
    >
      {{ label }}
    </NuxtLink>
  </div>
</template>
