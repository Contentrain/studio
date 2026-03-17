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
    <p class="mb-3 text-center text-sm text-muted">
      {{ description }}
    </p>
    <AtomsGhostButton block size="md" @click="$emit('click')">
      <template #prepend>
        <span class="icon-[annon--email] text-base" />
      </template>
      {{ label }}
    </AtomsGhostButton>
  </div>
</template>
