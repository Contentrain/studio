<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const { t } = useContent()
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8 lg:px-8">
    <AtomsHeadingText :level="1" size="lg">
      {{ t('common.settings') }}
    </AtomsHeadingText>
    <p class="mt-2 text-sm text-muted">
      Coming soon.
    </p>
  </div>
</template>
