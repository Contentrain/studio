<script setup lang="ts">
import type { BranchReview } from '~~/shared/utils/branch-review'
import type { BranchRawDiff } from '~/composables/useBranches'
import { formatRelativeTime } from '~/utils/relative-time'

/**
 * A pending content branch, as the person approving it needs to read it.
 *
 * What replaced what: this panel used to render `getBranchDiff`'s file list and
 * hand-roll a "field diff" over each file's JSON. On a collection that meant
 * labelling entry ids as fields and printing two whole entry objects for a
 * one-word edit, which is the output a non-technical editor could make no sense
 * of. The server now returns entries and their changed fields, and this renders
 * them with the same components the content views use.
 *
 * The file-level diff is still reachable — a technical view, fetched only when
 * opened, since that request is the one that reads every changed file whole.
 */
const props = defineProps<{
  review: BranchReview
  raw?: BranchRawDiff | null
  rawLoading?: boolean
}>()

const emit = defineEmits<{
  merge: []
  reject: []
  loadRaw: []
}>()

const { t } = useContent()

const confirmReject = ref(false)
const technicalOpen = ref(false)

const totalChanges = computed(() => {
  const { added, updated, removed } = props.review.summary
  const settingsItems = props.review.settings.reduce((sum, s) => sum + s.items.length, 0)
  return added + updated + removed + props.review.schema.length + settingsItems
})

const isEmpty = computed(() => totalChanges.value === 0 && props.review.unclassified.length === 0)

/** With only a handful of entries, reading them should not cost a click each. */
const expandEntries = computed(() => props.review.summary.added + props.review.summary.updated + props.review.summary.removed <= 5)

const authored = computed(() => {
  const { updatedBy, updatedAt, timestamp } = props.review.info
  const when = formatRelativeTime(updatedAt ?? timestamp, t)
  return { by: updatedBy, when }
})

const hasDestructiveSchema = computed(() => props.review.schema.some(s => s.destructive))

/**
 * With one group and nothing else on screen, the group's own header repeats
 * the panel header word for word. It earns its place only when there is
 * something to separate it from.
 */
const showGroupHeaders = computed(() =>
  props.review.groups.length > 1 || props.review.schema.length > 0 || props.review.settings.length > 0,
)

/**
 * A singleton or a dictionary holds one record that IS the model. Giving it a
 * collapsible row titled after the model puts that name on screen a third
 * time, above its own fields.
 */
const isSingleRecord = (kind: string) => kind === 'singleton' || kind === 'dictionary'

/** True when an entry's author and time are the ones the header already shows. */
function repeatsHeader(entry: { updatedBy: string | null, updatedAt: string | null }): boolean {
  return entry.updatedBy === props.review.info.updatedBy && entry.updatedAt === props.review.info.updatedAt
}

const STATUS_ICON: Record<string, string> = {
  added: 'icon-[annon--plus-circle]',
  modified: 'icon-[annon--edit]',
  removed: 'icon-[annon--minus-circle]',
}

function handleReject() {
  if (!confirmReject.value) {
    confirmReject.value = true
    return
  }
  confirmReject.value = false
  emit('reject')
}

function toggleTechnical() {
  technicalOpen.value = !technicalOpen.value
  if (technicalOpen.value && !props.raw) emit('loadRaw')
}

function stripPrefix(path: string): string {
  return path.replace(/^\.contentrain\/(?:content|meta)\//, '')
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- What this change is, in the project's own words -->
    <div class="shrink-0 border-b border-secondary-200 px-4 py-3 dark:border-secondary-800">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-heading dark:text-secondary-100">
            {{ review.info.modelName ?? t(`review.scope_${review.info.scope || 'other'}`) }}
            <span v-if="review.info.locale" class="text-muted">· {{ review.info.locale.toUpperCase() }}</span>
          </p>
          <p v-if="authored.by || authored.when" class="mt-0.5 truncate text-[11px] text-muted">
            <span v-if="authored.by">{{ authored.by }}</span>
            <span v-if="authored.by && authored.when" aria-hidden="true"> · </span>
            <span v-if="authored.when">{{ authored.when }}</span>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <AtomsBadge v-if="review.summary.added > 0" variant="success" size="sm">
            +{{ review.summary.added }}
          </AtomsBadge>
          <AtomsBadge v-if="review.summary.updated > 0" variant="warning" size="sm">
            ~{{ review.summary.updated }}
          </AtomsBadge>
          <AtomsBadge v-if="review.summary.removed > 0" variant="danger" size="sm">
            -{{ review.summary.removed }}
          </AtomsBadge>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      <div v-if="isEmpty" class="p-5">
        <AtomsEmptyState icon="icon-[annon--check-circle]" :title="t('branch.no_changes')" />
      </div>

      <!-- Structure changes read louder than content: they can take content
           with them, and approving one by accident is not recoverable here. -->
      <section v-if="review.schema.length > 0" class="px-4 py-3">
        <AtomsSectionLabel :label="t('review.schema_section')" class="mb-1 px-0" />
        <div
          v-for="change in review.schema"
          :key="change.modelId"
          class="mb-2 rounded-lg border px-3 py-2 last:mb-0"
          :class="change.destructive
            ? 'border-warning-300 bg-warning-50 dark:border-warning-800 dark:bg-warning-900/20'
            : 'border-secondary-200 dark:border-secondary-800'"
        >
          <p class="text-xs font-medium text-heading dark:text-secondary-100">
            {{ t(`review.model_${change.kind}`, { model: change.modelName }) }}
          </p>
          <ul class="mt-1 space-y-0.5 text-[11px] text-body">
            <li v-for="field in change.added" :key="`a-${field.fieldId}`">
              <span class="text-success-600 dark:text-success-400">+</span>
              {{ t('review.field_added', { field: field.label, type: field.type }) }}
            </li>
            <li v-for="field in change.removed" :key="`r-${field.fieldId}`">
              <span class="text-danger-500">−</span>
              {{ t('review.field_removed', { field: field.label }) }}
            </li>
            <li v-for="field in change.retyped" :key="`t-${field.fieldId}`">
              <span class="text-warning-500">~</span>
              {{ t('review.field_retyped', { field: field.label, from: field.fromType ?? '', to: field.type }) }}
            </li>
            <li v-if="change.titleFieldAfter">
              {{ t('review.title_field_changed', { field: change.titleFieldAfter }) }}
            </li>
          </ul>
          <p v-if="change.destructive" class="mt-1.5 flex items-start gap-1 text-[11px] text-warning-700 dark:text-warning-400">
            <span class="icon-[annon--alert-triangle] mt-px size-3 shrink-0" aria-hidden="true" />
            {{ t('review.schema_destructive') }}
          </p>
        </div>
      </section>

      <!-- Project settings -->
      <section v-if="review.settings.length > 0" class="px-4 py-3">
        <AtomsSectionLabel :label="t('review.settings_section')" class="mb-1 px-0" />
        <ul class="space-y-0.5 text-[11px] text-body">
          <li v-for="(change, ci) in review.settings" :key="ci">
            <template v-for="(item, ii) in change.items" :key="ii">
              <span class="block">{{ t(`review.settings_${item.key}`, { values: item.values.join(', ') }) }}</span>
            </template>
          </li>
        </ul>
      </section>

      <!-- Content, grouped by the model an editor opened -->
      <section v-for="group in review.groups" :key="`${group.modelId}:${group.locale ?? ''}`" class="px-4 pb-2 pt-3">
        <AtomsSectionLabel
          v-if="showGroupHeaders"
          :label="group.locale ? `${group.modelName} · ${group.locale.toUpperCase()}` : group.modelName"
          :count="group.entries.length"
          class="mb-1 px-0"
        />
        <MoleculesReviewEntryCard
          v-for="entry in group.entries"
          :key="entry.entryId"
          :entry="entry"
          :default-open="expandEntries"
          :headless="isSingleRecord(group.kind)"
          :hide-author="repeatsHeader(entry)"
        />
        <p v-if="group.omittedEntries > 0" class="pt-1 text-[11px] italic text-muted">
          {{ t('review.entries_omitted', { count: group.omittedEntries }) }}
        </p>
      </section>

      <!-- Anything the classifier could not attribute. Shown, never swallowed. -->
      <section v-if="review.unclassified.length > 0" class="px-4 py-3">
        <AtomsSectionLabel :label="t('review.unclassified_section')" :count="review.unclassified.length" class="mb-1 px-0" />
        <p class="mb-1 text-[11px] text-muted">
          {{ t('review.unclassified_hint') }}
        </p>
        <ul class="space-y-0.5">
          <li v-for="file in review.unclassified" :key="file.path" class="flex items-center gap-2">
            <span :class="STATUS_ICON[file.status]" class="size-3 shrink-0 text-muted" aria-hidden="true" />
            <span class="truncate font-mono text-[11px] text-body">{{ file.path }}</span>
          </li>
        </ul>
      </section>

      <!-- The git view, for whoever wants it -->
      <section v-if="!isEmpty" class="border-t border-secondary-100 px-4 py-3 dark:border-secondary-800/50">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded text-[11px] text-muted transition-colors hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
          :aria-expanded="technicalOpen"
          @click="toggleTechnical"
        >
          <span
            class="icon-[annon--chevron-right] size-3 transition-transform"
            :class="technicalOpen ? 'rotate-90' : ''"
            aria-hidden="true"
          />
          {{ t('review.technical_view') }}
        </button>

        <div v-if="technicalOpen" class="mt-2">
          <p v-if="raw" class="mb-1 text-[11px] text-muted">
            {{ t('branch.files_changed', { count: raw.files.length }) }}
          </p>
          <div v-if="rawLoading" class="space-y-2">
            <AtomsSkeleton v-for="i in 3" :key="i" variant="custom" class="h-8 w-full rounded" />
          </div>
          <details
            v-for="file in raw?.files ?? []"
            v-else
            :key="file.path"
            class="group border-b border-secondary-100 last:border-b-0 dark:border-secondary-800/50"
          >
            <summary class="flex cursor-pointer items-center gap-2 py-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50">
              <span
                class="icon-[annon--chevron-right] size-3 shrink-0 text-muted transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              <span :class="STATUS_ICON[file.status]" class="size-3 shrink-0 text-muted" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate font-mono text-body">{{ stripPrefix(file.path) }}</span>
              <span class="shrink-0 text-muted">{{ t(`branch.${file.status}`) }}</span>
            </summary>
            <pre class="max-h-64 overflow-auto rounded bg-secondary-50 p-2 text-[10px] text-body dark:bg-secondary-900">{{ typeof raw?.contents[file.path]?.after === 'string' ? raw?.contents[file.path]?.after : JSON.stringify(raw?.contents[file.path]?.after, null, 2) }}</pre>
          </details>
        </div>
      </section>
    </div>

    <!-- Actions say what they will do, not just what they are called -->
    <div v-if="review.canMerge || review.canReject" class="shrink-0 border-t border-secondary-200 p-4 dark:border-secondary-800">
      <p v-if="hasDestructiveSchema" class="mb-2 flex items-start gap-1 text-[11px] text-warning-700 dark:text-warning-400">
        <span class="icon-[annon--alert-triangle] mt-px size-3 shrink-0" aria-hidden="true" />
        {{ t('review.approve_destructive_hint') }}
      </p>
      <div class="flex items-center gap-2">
        <AtomsBaseButton v-if="review.canMerge" variant="primary" class="flex-1" :disabled="isEmpty" @click="emit('merge')">
          <span class="icon-[annon--check] size-4" aria-hidden="true" />
          {{ totalChanges === 1 ? t('review.approve_action_one') : t('review.approve_action_many', { count: totalChanges }) }}
        </AtomsBaseButton>
        <AtomsBaseButton
          v-if="review.canReject"
          :variant="confirmReject ? 'danger' : 'ghost'"
          @click="handleReject"
        >
          <span class="icon-[annon--cross] size-4" aria-hidden="true" />
          {{ confirmReject ? (totalChanges === 1 ? t('review.reject_confirm_one') : t('review.reject_confirm_many', { count: totalChanges })) : t('branch.reject') }}
        </AtomsBaseButton>
      </div>
    </div>
    <div v-else-if="!isEmpty" class="shrink-0 border-t border-secondary-200 px-4 py-3 dark:border-secondary-800">
      <p class="text-[11px] text-muted">
        {{ t('review.read_only') }}
      </p>
    </div>
  </div>
</template>
