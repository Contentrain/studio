<script setup lang="ts">
interface Warning {
  modelId: string
  type: string
  field?: string
  severity: 'critical' | 'error' | 'warning'
  affectedEntries: number
  message: string
}

const props = defineProps<{
  warning: Warning
}>()

const emit = defineEmits<{
  askAgent: [prompt: string]
}>()

const { t } = useContent()

const severityConfig: Record<string, { icon: string, colorClass: string }> = {
  critical: {
    icon: 'icon-[annon--alert-circle]',
    colorClass: 'text-danger-500',
  },
  error: {
    icon: 'icon-[annon--alert-triangle]',
    colorClass: 'text-warning-500',
  },
  warning: {
    icon: 'icon-[annon--info]',
    colorClass: 'text-info-500',
  },
}

const config = computed(() => severityConfig[props.warning.severity] ?? { icon: 'icon-[annon--info]', colorClass: 'text-info-500' })

function handleAskAgent() {
  const prompt = `Fix the schema issue: ${props.warning.message} in model ${props.warning.modelId}`
  emit('askAgent', prompt)
}
</script>

<template>
  <div class="group/warning flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900">
    <!-- Severity icon -->
    <span
      :class="[config.icon, config.colorClass]"
      class="block size-4 shrink-0"
      aria-hidden="true"
    />

    <!-- Content -->
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        <span class="text-xs font-medium text-label">
          {{ warning.modelId }}
        </span>
        <span v-if="warning.field" class="text-xs text-muted">
          / {{ warning.field }}
        </span>
      </div>
      <p class="mt-0.5 text-sm text-body dark:text-secondary-300">
        {{ warning.message }}
      </p>
    </div>

    <!-- Affected count badge -->
    <AtomsBadge v-if="warning.affectedEntries > 0" variant="secondary" size="sm" class="shrink-0">
      {{ warning.affectedEntries }}
    </AtomsBadge>

    <!-- Ask agent button -->
    <button
      type="button"
      class="shrink-0 rounded px-2 py-1 text-xs font-medium text-primary-600 opacity-0 transition-[color,opacity] hover:bg-primary-50 group-hover/warning:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400 dark:hover:bg-primary-900/30"
      @click="handleAskAgent"
    >
      {{ t('health.ask_agent') }}
    </button>
  </div>
</template>
