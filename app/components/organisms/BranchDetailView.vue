<script setup lang="ts">
const { t } = useContent()

interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'removed'
}

interface BranchDiffData {
  readonly branch: string
  readonly files: readonly FileDiff[]
  readonly contents: Readonly<Record<string, { readonly before: unknown, readonly after: unknown }>>
}

const props = defineProps<{
  diff: BranchDiffData
  canManage: boolean
}>()

const emit = defineEmits<{
  merge: []
  reject: []
}>()

const confirmReject = ref(false)

const statusCounts = computed(() => {
  const counts = { added: 0, modified: 0, removed: 0 }
  for (const file of props.diff.files) {
    counts[file.status]++
  }
  return counts
})

const statusColor: Record<string, string> = {
  added: 'success',
  modified: 'warning',
  removed: 'danger',
}

const statusIcon: Record<string, string> = {
  added: 'icon-[annon--plus-circle]',
  modified: 'icon-[annon--edit]',
  removed: 'icon-[annon--minus-circle]',
}

/**
 * Compute field-level diffs for JSON content.
 * Returns only changed/added/removed keys.
 */
function getFieldDiffs(before: unknown, after: unknown): Array<{ key: string, type: 'added' | 'modified' | 'removed', oldValue?: unknown, newValue?: unknown }> {
  const diffs: Array<{ key: string, type: 'added' | 'modified' | 'removed', oldValue?: unknown, newValue?: unknown }> = []

  const beforeObj = (typeof before === 'object' && before !== null) ? before as Record<string, unknown> : {}
  const afterObj = (typeof after === 'object' && after !== null) ? after as Record<string, unknown> : {}

  const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])

  for (const key of allKeys) {
    const hasOld = key in beforeObj
    const hasNew = key in afterObj

    if (!hasOld && hasNew) {
      diffs.push({ key, type: 'added', newValue: afterObj[key] })
    }
    else if (hasOld && !hasNew) {
      diffs.push({ key, type: 'removed', oldValue: beforeObj[key] })
    }
    else if (JSON.stringify(beforeObj[key]) !== JSON.stringify(afterObj[key])) {
      diffs.push({ key, type: 'modified', oldValue: beforeObj[key], newValue: afterObj[key] })
    }
  }

  return diffs
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value.length > 120 ? `${value.substring(0, 120)}…` : value
  return JSON.stringify(value, null, 0)
}

function stripPrefix(path: string): string {
  // Strip .contentrain/content/ prefix for cleaner display
  return path.replace(/^\.contentrain\/content\//, '')
}

function handleReject() {
  if (!confirmReject.value) {
    confirmReject.value = true
    return
  }
  confirmReject.value = false
  emit('reject')
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Summary bar -->
    <div class="flex items-center gap-2 border-b border-secondary-200 px-4 py-2.5 dark:border-secondary-800">
      <span class="text-xs font-medium text-heading dark:text-secondary-100">
        {{ t('branch.files_changed').replace('{count}', String(diff.files.length)) }}
      </span>
      <div class="ml-auto flex items-center gap-2">
        <AtomsBadge v-if="statusCounts.added > 0" variant="success" size="sm">
          +{{ statusCounts.added }}
        </AtomsBadge>
        <AtomsBadge v-if="statusCounts.modified > 0" variant="warning" size="sm">
          ~{{ statusCounts.modified }}
        </AtomsBadge>
        <AtomsBadge v-if="statusCounts.removed > 0" variant="danger" size="sm">
          -{{ statusCounts.removed }}
        </AtomsBadge>
      </div>
    </div>

    <!-- File list -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="diff.files.length === 0" class="p-5">
        <AtomsEmptyState icon="icon-[annon--check-circle]" :title="t('branch.no_changes')" />
      </div>

      <details
        v-for="file in diff.files"
        :key="file.path"
        class="group border-b border-secondary-100 dark:border-secondary-800/50"
      >
        <summary class="flex items-center gap-2 px-4 py-2 text-sm transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900">
          <span
            class="icon-[annon--chevron-right] size-3 shrink-0 text-muted transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          <span :class="statusIcon[file.status]" class="size-3.5 shrink-0" :style="{ color: `var(--color-${statusColor[file.status]}-500)` }" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-heading dark:text-secondary-100">
            {{ stripPrefix(file.path) }}
          </span>
          <AtomsBadge :variant="(statusColor[file.status] as 'success' | 'warning' | 'danger')" size="sm">
            {{ t(`branch.${file.status}`) }}
          </AtomsBadge>
        </summary>

        <!-- Field-level diff for JSON -->
        <div v-if="diff.contents[file.path] && file.path.endsWith('.json')" class="bg-secondary-50/50 px-4 py-2 dark:bg-secondary-900/30">
          <div
            v-for="fieldDiff in getFieldDiffs(diff.contents[file.path]?.before, diff.contents[file.path]?.after)"
            :key="fieldDiff.key"
            class="flex items-start gap-2 border-b border-secondary-100 py-1.5 last:border-b-0 dark:border-secondary-800/30"
          >
            <span class="shrink-0 font-mono text-[11px] font-medium text-label">{{ fieldDiff.key }}</span>
            <div class="min-w-0 flex-1 text-[11px]">
              <template v-if="fieldDiff.type === 'added'">
                <span class="text-success-600 dark:text-success-400">{{ formatValue(fieldDiff.newValue) }}</span>
              </template>
              <template v-else-if="fieldDiff.type === 'removed'">
                <span class="text-danger-500 line-through">{{ formatValue(fieldDiff.oldValue) }}</span>
              </template>
              <template v-else>
                <span class="text-danger-500 line-through">{{ formatValue(fieldDiff.oldValue) }}</span>
                <span class="mx-1 text-muted">→</span>
                <span class="text-success-600 dark:text-success-400">{{ formatValue(fieldDiff.newValue) }}</span>
              </template>
            </div>
          </div>

          <div v-if="getFieldDiffs(diff.contents[file.path]?.before, diff.contents[file.path]?.after).length === 0" class="py-1 text-[11px] text-muted">
            {{ t('branch.no_changes') }}
          </div>
        </div>

        <!-- Raw display for non-JSON (markdown, etc.) -->
        <div v-else-if="diff.contents[file.path]" class="bg-secondary-50/50 px-4 py-2 dark:bg-secondary-900/30">
          <pre v-if="diff.contents[file.path]?.after" class="max-h-40 overflow-auto text-[11px] text-body">{{ diff.contents[file.path]?.after }}</pre>
        </div>
      </details>
    </div>

    <!-- Actions -->
    <div v-if="canManage && diff.files.length > 0" class="shrink-0 border-t border-secondary-200 p-4 dark:border-secondary-800">
      <div class="flex items-center gap-2">
        <AtomsBaseButton variant="primary" class="flex-1" @click="emit('merge')">
          <span class="icon-[annon--check] size-4" aria-hidden="true" />
          {{ t('branch.approve_merge') }}
        </AtomsBaseButton>
        <AtomsBaseButton
          :variant="confirmReject ? 'danger' : 'ghost'"
          @click="handleReject"
        >
          <span class="icon-[annon--cross] size-4" aria-hidden="true" />
          {{ confirmReject ? t('branch.confirm_reject') : t('branch.reject') }}
        </AtomsBaseButton>
      </div>
    </div>
  </div>
</template>
