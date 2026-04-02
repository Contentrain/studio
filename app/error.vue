<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{
  error: NuxtError
}>()

const { t } = useContent()

const statusCode = computed(() => props.error.statusCode ?? 500)

const is402 = computed(() => statusCode.value === 402)

const title = computed(() => {
  if (is402.value) return t('error.402_title')
  if (statusCode.value === 403) return t('error.403_title')
  if (statusCode.value === 404) return t('error.404_title')
  if (statusCode.value === 500) return t('error.500_title')
  return t('error.generic_title')
})

const description = computed(() => {
  if (is402.value) return t('error.402_description')
  if (statusCode.value === 403) return t('error.403_description')
  if (statusCode.value === 404) return t('error.404_description')
  if (statusCode.value === 500) return t('error.500_description')
  return t('error.generic_description')
})

const planModalOpen = ref(false)

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
      <div class="mt-8 flex items-center justify-center gap-3">
        <AtomsBaseButton
          v-if="is402"
          size="md"
          variant="primary"
          @click="planModalOpen = true"
        >
          <span>{{ t('billing.upgrade') }}</span>
        </AtomsBaseButton>
        <AtomsBaseButton
          size="md"
          :variant="is402 ? 'secondary' : 'primary'"
          @click="handleClear"
        >
          <span>{{ t('common.go_home') }}</span>
        </AtomsBaseButton>
      </div>

      <!-- Plan selection for 402 -->
      <OrganismsPlanSelectionModal
        v-if="is402"
        :open="planModalOpen"
        @update:open="planModalOpen = $event"
      />
    </div>
  </div>
</template>
