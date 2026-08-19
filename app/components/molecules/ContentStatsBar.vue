<script setup lang="ts">
defineProps<{
  modelCount: number
  entryCount: number
  locales: readonly string[]
  healthScore: number
}>()

const emit = defineEmits<{
  viewHealth: []
}>()

const { t } = useContent()
</script>

<template>
  <div class="flex items-center gap-3 border-b border-secondary-100 px-5 py-2.5 dark:border-secondary-800/50">
    <!-- Models -->
    <AtomsTooltip :text="t('content.stat_models')">
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <span class="icon-[annon--layers] size-3.5" aria-hidden="true" />
        <span class="font-medium">{{ modelCount }}</span>
      </div>
    </AtomsTooltip>

    <!-- Entries -->
    <AtomsTooltip :text="t('content.stat_entries')">
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <span class="icon-[annon--file-text] size-3.5" aria-hidden="true" />
        <span class="font-medium">{{ entryCount }}</span>
      </div>
    </AtomsTooltip>

    <!-- Locales -->
    <AtomsTooltip v-if="locales.length > 0" :text="`${t('content.stat_locales')}: ${locales.join(', ')}`">
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <span class="icon-[annon--globe] size-3.5" aria-hidden="true" />
        <span class="font-medium">{{ locales.map(l => l.toUpperCase()).join(', ') }}</span>
      </div>
    </AtomsTooltip>

    <!-- Health score -->
    <AtomsTooltip :text="`${t('health.score_label')}: ${healthScore}/100`">
      <button type="button" class="ml-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50" @click="emit('viewHealth')">
        <AtomsHealthScoreBadge :score="healthScore" size="sm" />
      </button>
    </AtomsTooltip>
  </div>
</template>
