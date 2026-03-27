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

const tierVariants: Record<string, 'success' | 'warning' | 'danger' | 'info'> = {
  excellent: 'success',
  good: 'success',
  fair: 'warning',
  poor: 'danger',
}

function handleAskAgent(prompt: string) {
  emit('sendChatPrompt', prompt)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex h-14 shrink-0 items-center gap-2 border-b border-secondary-200 px-5 dark:border-secondary-800">
      <AtomsIconButton
        icon="icon-[annon--arrow-left]"
        :label="t('common.back')"
        @click="emit('back')"
      />
      <AtomsHeadingText :level="3" size="xs" truncate class="flex-1">
        {{ t('health.title') }}
      </AtomsHeadingText>
      <AtomsHealthScoreBadge :score="healthScore" size="md" />
      <AtomsBadge :variant="tierVariants[healthTier] ?? 'secondary'" size="sm">
        {{ t(tierKeys[healthTier] ?? 'health.tier_good') }}
      </AtomsBadge>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      <!-- Summary stat cards -->
      <div class="grid grid-cols-3 gap-3 p-5">
        <!-- Critical -->
        <div class="rounded-lg border border-secondary-200 bg-white p-4 dark:border-secondary-800 dark:bg-secondary-950">
          <div class="flex items-center gap-2">
            <span class="icon-[annon--alert-circle] block size-4 text-danger-500" aria-hidden="true" />
            <span class="text-xs font-medium text-muted">{{ t('health.critical') }}</span>
          </div>
          <p class="mt-2 text-2xl font-semibold tabular-nums text-danger-600 dark:text-danger-400">
            {{ criticalCount }}
          </p>
        </div>

        <!-- Errors -->
        <div class="rounded-lg border border-secondary-200 bg-white p-4 dark:border-secondary-800 dark:bg-secondary-950">
          <div class="flex items-center gap-2">
            <span class="icon-[annon--alert-triangle] block size-4 text-warning-500" aria-hidden="true" />
            <span class="text-xs font-medium text-muted">{{ t('health.errors') }}</span>
          </div>
          <p class="mt-2 text-2xl font-semibold tabular-nums text-warning-600 dark:text-warning-400">
            {{ errorCount }}
          </p>
        </div>

        <!-- Warnings -->
        <div class="rounded-lg border border-secondary-200 bg-white p-4 dark:border-secondary-800 dark:bg-secondary-950">
          <div class="flex items-center gap-2">
            <span class="icon-[annon--info] block size-4 text-info-500" aria-hidden="true" />
            <span class="text-xs font-medium text-muted">{{ t('health.warnings') }}</span>
          </div>
          <p class="mt-2 text-2xl font-semibold tabular-nums text-info-600 dark:text-info-400">
            {{ warningCount }}
          </p>
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
            <!-- Model group header -->
            <div class="flex items-center gap-2 px-5 py-2 bg-secondary-50 dark:bg-secondary-900/50">
              <span class="icon-[annon--layers] block size-3.5 text-muted" aria-hidden="true" />
              <span class="text-xs font-semibold text-heading dark:text-secondary-100">
                {{ modelId }}
              </span>
              <AtomsBadge variant="secondary" size="sm">
                {{ modelWarnings.length }}
              </AtomsBadge>
            </div>

            <!-- Warning items -->
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

      <!-- Empty state — no issues -->
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
