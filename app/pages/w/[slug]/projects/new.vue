<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const { t } = useContent()
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8 lg:px-8">
    <AtomsHeadingText :level="1" size="lg">
      {{ t('projects.connect_repo') }}
    </AtomsHeadingText>
    <p class="mt-2 text-sm text-muted">
      Coming soon — GitHub App integration.
    </p>
  </div>
</template>
