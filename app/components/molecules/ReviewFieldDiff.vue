<script setup lang="ts">
import type { ReviewFieldChange } from '~~/shared/utils/branch-review'
import { wordDiff } from '~/utils/word-diff'

/**
 * One field, before and after.
 *
 * Values render through `AtomsContentFieldDisplay` — the same component the
 * content views use — so a boolean is a switch, an image is a thumbnail and a
 * date is a date, instead of every one of them being `JSON.stringify` output.
 * Long text gets a word-level diff, because the change in a 2,000-character
 * body is not visible any other way.
 */
const props = defineProps<{
  change: ReviewFieldChange
}>()

const { t } = useContent()

const LONG_TEXT_TYPES = new Set(['markdown', 'richtext', 'text', 'code'])

const isEmpty = (value: unknown) => value === null || value === undefined || value === ''

const isAdded = computed(() => isEmpty(props.change.before) && !isEmpty(props.change.after))
const isCleared = computed(() => !isEmpty(props.change.before) && isEmpty(props.change.after))

/**
 * Word diff is worth its cost only for prose. A short string reads better as
 * "old → new", and a non-string value has no words to align.
 */
const useWordDiff = computed(() => {
  const { type, before, after } = props.change
  if (typeof before !== 'string' || typeof after !== 'string') return false
  if (!LONG_TEXT_TYPES.has(type) && before.length < 80 && after.length < 80) return false
  return before.length > 0 && after.length > 0
})

const diff = computed(() =>
  useWordDiff.value
    ? wordDiff(String(props.change.before ?? ''), String(props.change.after ?? ''))
    : null,
)

/**
 * A relation stores refs; the review shows the titles the editor knows. Falls
 * back to the ref when the target could not be resolved — a dangling relation
 * is information, not something to hide.
 */
const relationLabel = (value: unknown): string | null => {
  const labels = props.change.refLabels
  if (!labels) return null
  const refs = Array.isArray(value) ? value : [value]
  const named = refs
    .map((ref) => {
      const key = typeof ref === 'string'
        ? ref
        : ref && typeof ref === 'object' && 'ref' in ref
          ? String((ref as { ref: unknown }).ref)
          : ''
      return key ? (labels[key] ?? key) : ''
    })
    .filter(Boolean)
  return named.length > 0 ? named.join(', ') : null
}

const beforeLabel = computed(() => relationLabel(props.change.before))
const afterLabel = computed(() => relationLabel(props.change.after))
</script>

<template>
  <div class="py-2">
    <div class="mb-1 flex items-center gap-2">
      <span class="text-[11px] font-medium text-label">{{ change.label }}</span>
      <AtomsBadge v-if="isAdded" variant="success" size="sm">
        {{ t('review.field_set') }}
      </AtomsBadge>
      <AtomsBadge v-else-if="isCleared" variant="danger" size="sm">
        {{ t('review.field_cleared') }}
      </AtomsBadge>
    </div>

    <!-- Prose: one body with the moved words marked, rather than two bodies -->
    <div v-if="diff" class="space-y-1.5">
      <p class="whitespace-pre-wrap break-words text-xs leading-relaxed text-body">
        <span
          v-for="(part, i) in diff.after"
          :key="`a${i}`"
          :class="part.kind === 'added' ? 'rounded bg-success-100 text-success-800 dark:bg-success-900/40 dark:text-success-300' : ''"
        >{{ part.value }}</span>
      </p>
      <details class="group">
        <summary class="inline-flex w-fit cursor-pointer items-center gap-1 rounded text-[11px] text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50">
          <span class="icon-[annon--chevron-right] size-3 transition-transform group-open:rotate-90" aria-hidden="true" />
          {{ t('review.show_previous') }}
        </summary>
        <p class="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
          <span
            v-for="(part, i) in diff.before"
            :key="`b${i}`"
            :class="part.kind === 'removed' ? 'rounded bg-danger-100 text-danger-700 line-through dark:bg-danger-900/40 dark:text-danger-300' : ''"
          >{{ part.value }}</span>
        </p>
      </details>
      <p v-if="diff.coarse" class="text-[11px] italic text-muted">
        {{ t('review.diff_coarse') }}
      </p>
    </div>

    <!-- Everything else: the two values, rendered as their type -->
    <div v-else class="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs">
      <div v-if="!isAdded" class="min-w-0 max-w-full opacity-70">
        <span v-if="beforeLabel" class="text-danger-500 line-through">{{ beforeLabel }}</span>
        <AtomsContentFieldDisplay
          v-else
          :type="change.type"
          :value="change.before"
          :field-id="change.fieldId"
        />
      </div>
      <span v-if="!isAdded && !isCleared" class="shrink-0 pt-0.5 text-muted" aria-hidden="true">→</span>
      <div v-if="!isCleared" class="min-w-0 max-w-full">
        <span v-if="afterLabel" class="text-success-600 dark:text-success-400">{{ afterLabel }}</span>
        <AtomsContentFieldDisplay
          v-else
          :type="change.type"
          :value="change.after"
          :field-id="change.fieldId"
        />
      </div>
    </div>

    <p v-if="change.truncated" class="mt-1 text-[11px] italic text-muted">
      {{ t('review.value_truncated') }}
    </p>
  </div>
</template>
