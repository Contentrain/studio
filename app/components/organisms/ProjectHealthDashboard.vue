<script setup lang="ts">
defineProps<{
  workspaceId: string
  projectId: string
}>()

const emit = defineEmits<{
  back: []
  sendChatPrompt: [text: string]
}>()

const { t } = useContent()

const {
  healthScore,
  healthTier,
  criticalCount,
  errorCount,
  warningCount,
  warningsByModel,
  hasIssues,
} = useProjectHealth()

const tierKeys: Record<string, string> = {
  excellent: 'health.tier_excellent',
  good: 'health.tier_good',
  fair: 'health.tier_fair',
  poor: 'health.tier_poor',
}

const scoreColor = computed(() => {
  if (healthScore.value >= 90) return 'text-success-500'
  if (healthScore.value >= 70) return 'text-warning-500'
  return 'text-danger-500'
})

const ringColor = computed(() => {
  if (healthScore.value >= 90) return 'stroke-success-500'
  if (healthScore.value >= 70) return 'stroke-warning-500'
  return 'stroke-danger-500'
})

const tierColor = computed(() => {
  if (healthScore.value >= 90) return 'text-success-600 dark:text-success-400'
  if (healthScore.value >= 70) return 'text-warning-600 dark:text-warning-400'
  return 'text-danger-600 dark:text-danger-400'
})

// SVG ring progress (circumference = 2 * PI * radius)
const RADIUS = 42
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const strokeDashoffset = computed(() =>
  CIRCUMFERENCE - (healthScore.value / 100) * CIRCUMFERENCE,
)

function handleAskAgent(prompt: string) {
  emit('sendChatPrompt', prompt)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex-1 overflow-y-auto">
      <!-- Hero score ring -->
      <div class="flex flex-col items-center px-5 pb-2 pt-6">
        <div class="relative size-24">
          <svg class="size-full -rotate-90" viewBox="0 0 100 100">
            <!-- Background ring -->
            <circle
              cx="50" cy="50" :r="RADIUS"
              fill="none"
              stroke-width="6"
              class="stroke-secondary-200 dark:stroke-secondary-800"
            />
            <!-- Progress ring -->
            <circle
              cx="50" cy="50" :r="RADIUS"
              fill="none"
              stroke-width="6"
              stroke-linecap="round"
              :class="ringColor"
              :stroke-dasharray="CIRCUMFERENCE"
              :stroke-dashoffset="strokeDashoffset"
              class="transition-all duration-700 ease-out"
            />
          </svg>
          <!-- Score number -->
          <div class="absolute inset-0 flex items-center justify-center">
            <span :class="scoreColor" class="text-2xl font-bold tabular-nums">
              {{ healthScore }}
            </span>
          </div>
        </div>
        <span :class="tierColor" class="mt-2 text-sm font-semibold">
          {{ t(tierKeys[healthTier] ?? 'health.tier_good') }}
        </span>
      </div>

      <!-- Stat cards -->
      <div class="grid grid-cols-3 gap-2 px-5 pb-5 pt-3">
        <div class="rounded-lg border border-secondary-200 bg-white px-3 py-2.5 text-center dark:border-secondary-800 dark:bg-secondary-900">
          <span class="icon-[annon--alert-circle] mx-auto block size-4 text-danger-500" aria-hidden="true" />
          <p class="mt-1 text-lg font-bold tabular-nums text-danger-600 dark:text-danger-400">
            {{ criticalCount }}
          </p>
          <span class="text-[10px] font-medium uppercase tracking-wider text-muted">{{ t('health.critical') }}</span>
        </div>
        <div class="rounded-lg border border-secondary-200 bg-white px-3 py-2.5 text-center dark:border-secondary-800 dark:bg-secondary-900">
          <span class="icon-[annon--alert-triangle] mx-auto block size-4 text-warning-500" aria-hidden="true" />
          <p class="mt-1 text-lg font-bold tabular-nums text-warning-600 dark:text-warning-400">
            {{ errorCount }}
          </p>
          <span class="text-[10px] font-medium uppercase tracking-wider text-muted">{{ t('health.errors') }}</span>
        </div>
        <div class="rounded-lg border border-secondary-200 bg-white px-3 py-2.5 text-center dark:border-secondary-800 dark:bg-secondary-900">
          <span class="icon-[annon--info] mx-auto block size-4 text-info-500" aria-hidden="true" />
          <p class="mt-1 text-lg font-bold tabular-nums text-info-600 dark:text-info-400">
            {{ warningCount }}
          </p>
          <span class="text-[10px] font-medium uppercase tracking-wider text-muted">{{ t('health.warnings') }}</span>
        </div>
      </div>

      <!-- Warnings list grouped by model -->
      <template v-if="hasIssues || warningCount > 0">
        <div class="border-t border-secondary-200 dark:border-secondary-800">
          <div class="px-5 py-3">
            <AtomsSectionLabel :label="t('health.issues_by_model')" />
          </div>

          <div
            v-for="(modelWarnings, modelId) in warningsByModel"
            :key="modelId"
            class="border-t border-secondary-100 dark:border-secondary-800/50"
          >
            <div class="flex items-center gap-2 bg-secondary-50 px-5 py-2 dark:bg-secondary-900/50">
              <span class="icon-[annon--layers] block size-3.5 text-muted" aria-hidden="true" />
              <span class="text-xs font-semibold text-heading dark:text-secondary-100">
                {{ modelId }}
              </span>
              <AtomsBadge variant="secondary" size="sm">
                {{ modelWarnings.length }}
              </AtomsBadge>
            </div>
            <div class="divide-y divide-secondary-100 dark:divide-secondary-800/50">
              <MoleculesHealthWarningItem
                v-for="(warning, idx) in modelWarnings"
                :key="`${modelId}-${idx}`"
                :warning="warning"
                @ask-agent="handleAskAgent"
              />
            </div>
          </div>
        </div>
      </template>

      <!-- Empty state -->
      <template v-else>
        <AtomsEmptyState
          icon="icon-[annon--check-circle]"
          :title="t('health.no_issues')"
          :description="t('health.no_issues_desc')"
        />
      </template>
    </div>
  </div>
</template>
