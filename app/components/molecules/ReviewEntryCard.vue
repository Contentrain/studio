<script setup lang="ts">
import type { ReviewEntryChange } from '~~/shared/utils/branch-review'
import { formatRelativeTime } from '~/utils/relative-time'

/**
 * One entry's change: what it is, what happened to it, and which of its fields
 * moved. This is the unit an editor thinks in — the panel used to show files.
 */
const props = defineProps<{
  entry: ReviewEntryChange
  /** Open by default when the branch is small enough to read at a glance. */
  defaultOpen?: boolean
}>()

const { t } = useContent()

const KIND_VARIANT: Record<ReviewEntryChange['kind'], 'success' | 'warning' | 'danger'> = {
  added: 'success',
  updated: 'warning',
  removed: 'danger',
}

const KIND_ICON: Record<ReviewEntryChange['kind'], string> = {
  added: 'icon-[annon--plus-circle]',
  updated: 'icon-[annon--edit]',
  removed: 'icon-[annon--minus-circle]',
}

const relative = computed(() => formatRelativeTime(props.entry.updatedAt, t))

/**
 * A publish is a real change even when no field moved, so it gets its own line
 * rather than being inferred from a meta file the panel no longer shows.
 */
const statusMoved = computed(() => props.entry.statusAfter !== null)
</script>

<template>
  <details :open="defaultOpen" class="group border-b border-secondary-100 last:border-b-0 dark:border-secondary-800/50">
    <summary class="flex cursor-pointer items-center gap-2 py-2 pl-1 pr-2 text-sm transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900">
      <span
        class="icon-[annon--chevron-right] size-3 shrink-0 text-muted transition-transform group-open:rotate-90"
        aria-hidden="true"
      />
      <span :class="KIND_ICON[entry.kind]" class="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-heading dark:text-secondary-100">{{ entry.title }}</span>

      <AtomsBadge v-if="statusMoved" variant="info" size="sm">
        {{ t(`review.status_${entry.statusAfter}`) }}
      </AtomsBadge>
      <AtomsBadge :variant="KIND_VARIANT[entry.kind]" size="sm">
        {{ t(`review.entry_${entry.kind}`) }}
      </AtomsBadge>
    </summary>

    <div class="pb-2 pl-7 pr-2">
      <p v-if="entry.updatedBy || relative" class="pb-1 text-[11px] text-muted">
        <span v-if="entry.updatedBy">{{ entry.updatedBy }}</span>
        <span v-if="entry.updatedBy && relative" aria-hidden="true"> · </span>
        <span v-if="relative">{{ relative }}</span>
      </p>

      <p v-if="statusMoved" class="pb-1 text-[11px] text-body">
        {{ entry.statusBefore ? t('review.status_moved', { from: t(`review.status_${entry.statusBefore}`), to: t(`review.status_${entry.statusAfter}`) }) : t('review.status_set', { to: t(`review.status_${entry.statusAfter}`) }) }}
      </p>

      <MoleculesReviewFieldDiff
        v-for="field in entry.fields"
        :key="field.fieldId"
        :change="field"
      />

      <p v-if="entry.fields.length === 0 && !statusMoved" class="py-1 text-[11px] italic text-muted">
        {{ t('review.no_field_changes') }}
      </p>
    </div>
  </details>
</template>
