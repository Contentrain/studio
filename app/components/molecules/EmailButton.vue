<script lang="ts" setup>
interface Props {
  label: string
  description: string
}

defineProps<Props>()

defineEmits<{
  click: []
}>()
</script>

<template>
  <div class="pt-10 text-center">
    <p class="mb-3 text-center text-sm text-gray-500 dark:text-gray-400">
      {{ description }}
    </p>
    <AtomsGhostButton block size="md" @click="$emit('click')">
      {{ label }}
    </AtomsGhostButton>
  </div>
</template>
