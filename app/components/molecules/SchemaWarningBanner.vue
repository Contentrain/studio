<script setup lang="ts">
const props = defineProps<{
  criticalCount: number
  errorCount: number
  warningCount: number
}>()

const emit = defineEmits<{
  viewDetails: []
  dismiss: []
}>()

const { t } = useContent()

const dismissed = ref(false)

const totalIssues = computed(() => props.criticalCount + props.errorCount)

const visible = computed(() => !dismissed.value && totalIssues.value > 0)

function handleDismiss() {
  dismissed.value = true
  emit('dismiss')
}
</script>

<template>
  <div
    v-if="visible"
    class="flex items-center gap-3 border border-warning-200 bg-warning-50 px-4 py-3 dark:border-warning-800 dark:bg-warning-900/20"
    role="alert"
  >
    <!-- Warning icon -->
    <span
      class="icon-[annon--alert-triangle] block size-4 shrink-0 text-warning-500"
      aria-hidden="true"
    />

    <!-- Message -->
    <p class="min-w-0 flex-1 text-sm font-medium text-warning-800 dark:text-warning-300">
      {{ t('health.schema_issues_detected') }} ({{ totalIssues }})
    </p>

    <!-- Actions -->
    <div class="flex shrink-0 items-center gap-2">
      <button
        type="button"
        class="rounded px-2.5 py-1 text-xs font-medium text-warning-700 transition-colors hover:bg-warning-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-warning-400 dark:hover:bg-warning-800/50"
        @click="emit('viewDetails')"
      >
        {{ t('health.view_details') }}
      </button>
      <button
        type="button"
        class="rounded p-1 text-warning-500 transition-colors hover:bg-warning-100 hover:text-warning-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-warning-800/50 dark:hover:text-warning-300"
        @click="handleDismiss"
      >
        <span class="icon-[annon--cross] block size-3.5" aria-hidden="true" />
        <span class="sr-only">{{ t('common.dismiss') }}</span>
      </button>
    </div>
  </div>
</template>
