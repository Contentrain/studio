<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const { t } = useContent()
</script>

<template>
  <div class="flex flex-1 items-center justify-center py-20">
    <div class="text-center">
      <span class="icon-[annon--home-2] text-4xl text-muted" />
      <h2 class="mt-4 text-lg font-medium text-secondary-900 dark:text-secondary-100">
        {{ t('projects.title') }}
      </h2>
      <p class="mt-2 text-sm text-muted">
        {{ t('projects.empty_description') }}
      </p>
    </div>
  </div>
</template>
