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
  /**
   * Render the fields with no title row of their own. A singleton or a
   * dictionary has one record that IS the model, so a row repeating the
   * model's name above its own fields is the third place the same word
   * appears on screen.
   */
  headless?: boolean
  /**
   * The panel header already names this author and time. Repeating them per
   * entry only says something when they differ.
   */
  hideAuthor?: boolean
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
const showAuthor = computed(() => !props.hideAuthor && (props.entry.updatedBy || relative.value))

/**
 * A publish is a real change even when no field moved. It is said once, as a
 * badge carrying the whole transition — `Draft → Published` reads at a glance
 * whether the entry is open or closed, which a separate line inside it did
 * not, and the two of them together said the same thing twice.
 */
const statusLabel = computed(() => {
  const { statusBefore, statusAfter } = props.entry
  if (!statusAfter) return null
  const to = t(`review.status_${statusAfter}`)
  return statusBefore ? t('review.status_transition', { from: t(`review.status_${statusBefore}`), to }) : to
})

/**
 * An entry whose only change is its status is not "updated" in any sense the
 * status badge has not already covered.
 */
const showKindBadge = computed(() =>
  !(props.entry.kind === 'updated' && props.entry.fields.length === 0 && statusLabel.value),
)

/**
 * Whether there is anything under the row at all.
 *
 * A publish that touched no field leaves nothing: no fields, no author line
 * once it matches the header's, and no "nothing changed" note because the
 * status badge already said what happened. The row still opened, onto empty
 * space. It does not open now.
 */
const hasBody = computed(() =>
  props.entry.fields.length > 0
  || showAuthor.value
  // A headless entry has no row of its own, so its status badge lives in the
  // body — which therefore has to exist for it.
  || (props.headless && !!statusLabel.value)
  || !statusLabel.value,
)

const collapsible = computed(() => !props.headless && hasBody.value)
</script>

<template>
  <component :is="collapsible ? 'details' : 'div'" :open="collapsible ? defaultOpen : undefined" class="group border-b border-secondary-100 last:border-b-0 dark:border-secondary-800/50">
    <component
      :is="collapsible ? 'summary' : 'div'"
      v-if="!headless"
      class="flex items-center gap-2 py-2 pl-1 pr-2 text-sm"
      :class="collapsible
        ? 'cursor-pointer transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900'
        : ''"
    >
      <span
        v-if="collapsible"
        class="icon-[annon--chevron-right] size-3 shrink-0 text-muted transition-transform group-open:rotate-90"
        aria-hidden="true"
      />
      <!-- Keeps a non-opening row's title aligned with the ones above it. -->
      <span v-else class="size-3 shrink-0" aria-hidden="true" />
      <span :class="KIND_ICON[entry.kind]" class="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-heading dark:text-secondary-100">{{ entry.title }}</span>

      <AtomsBadge v-if="statusLabel" variant="info" size="sm">
        {{ statusLabel }}
      </AtomsBadge>
      <AtomsBadge v-if="showKindBadge" :variant="KIND_VARIANT[entry.kind]" size="sm">
        {{ t(`review.entry_${entry.kind}`) }}
      </AtomsBadge>
    </component>

    <div v-if="hasBody" :class="headless ? 'pb-2' : 'pb-2 pl-7 pr-2'">
      <!-- Headless entries have no summary row, so the status rides here -->
      <div v-if="headless && statusLabel" class="pb-1">
        <AtomsBadge variant="info" size="sm">
          {{ statusLabel }}
        </AtomsBadge>
      </div>

      <p v-if="showAuthor" class="pb-1 text-[11px] text-muted">
        <span v-if="entry.updatedBy">{{ entry.updatedBy }}</span>
        <span v-if="entry.updatedBy && relative" aria-hidden="true"> · </span>
        <span v-if="relative">{{ relative }}</span>
      </p>

      <MoleculesReviewFieldDiff
        v-for="field in entry.fields"
        :key="field.fieldId"
        :change="field"
        :entry-is-new="entry.kind === 'added'"
      />

      <p v-if="entry.fields.length === 0 && !statusLabel" class="py-1 text-[11px] italic text-muted">
        {{ t('review.no_field_changes') }}
      </p>
    </div>
  </component>
</template>
