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
    <p class="text-sm text-gray-500 dark:text-gray-400 mb-2">
      {{ description }}
    </p>
    <NuxtLink
      :to="to"
      class="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
    >
      {{ label }}
    </NuxtLink>
  </div>
</template>
