<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{
  error: NuxtError
}>()

const { t } = useContent()

const statusCode = computed(() => props.error.statusCode ?? 500)

const title = computed(() => {
  if (statusCode.value === 403) return t('error.403_title')
  if (statusCode.value === 404) return t('error.404_title')
  if (statusCode.value === 500) return t('error.500_title')
  return t('error.generic_title')
})

const description = computed(() => {
  if (statusCode.value === 403) return t('error.403_description')
  if (statusCode.value === 404) return t('error.404_description')
  if (statusCode.value === 500) return t('error.500_description')
  return t('error.generic_description')
})

function handleClear() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-white px-4 dark:bg-secondary-950">
    <div class="text-center">
      <p class="text-7xl font-bold text-secondary-200 dark:text-secondary-800">
        {{ statusCode }}
      </p>
      <AtomsHeadingText :level="1" size="lg" class="mt-4">
        {{ title }}
      </AtomsHeadingText>
      <p class="mt-2 max-w-sm text-sm text-muted">
        {{ description }}
      </p>
      <AtomsBaseButton
        size="md"
        variant="primary"
        class="mt-8"
        @click="handleClear"
      >
        <span>{{ t('common.go_home') }}</span>
      </AtomsBaseButton>
    </div>
  </div>
</template>
