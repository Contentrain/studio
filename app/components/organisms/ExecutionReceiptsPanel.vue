<script setup lang="ts">
import type { ExecutionReceipt } from '@contentrain/types'
import { shortPlanHash } from '~~/shared/utils/approval'
import { formatRelativeTime } from '~/utils/relative-time'

/**
 * What has been run under an approval.
 *
 * The record exists because "who let this in" is a question asked after the
 * fact, usually by someone who was not there. Each row carries the plan it ran,
 * what it actually touched, who ran it, and the decisions that permitted it —
 * the grants are cleared when a branch lands, so the receipt keeps its own copy
 * rather than pointing at rows that can be deleted out from under it.
 */
const props = defineProps<{
  workspaceId: string
  projectId: string
}>()

interface ReceiptRow {
  id: string
  target: string
  planHash: string
  createdAt: string
  receipt: ExecutionReceipt
}

const { t } = useContent()
const loading = ref(true)
const rows = ref<ReceiptRow[]>([])

onMounted(async () => {
  try {
    const result = await $fetch<{ receipts: ReceiptRow[] }>(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/receipts`)
    rows.value = result.receipts
  }
  catch {
    rows.value = []
  }
  finally {
    loading.value = false
  }
})

function approversOf(receipt: ExecutionReceipt): string {
  return (receipt.approvals ?? []).map(a => a.approver.name ?? a.approver.id).join(', ')
}

function scopeOf(receipt: ExecutionReceipt): string {
  const s = receipt.applied ?? {}
  const parts = [
    s.models?.length ? t('receipts.scope_models', { count: s.models.length }) : null,
    s.locales?.length ? s.locales.join(', ') : null,
    s.entries?.length ? t('receipts.scope_entries', { count: s.entries.length }) : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

/** The record as it is stored — the export is the receipt, not a rendering of it. */
function download(row: ReceiptRow) {
  const blob = new Blob([JSON.stringify(row.receipt, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `receipt-${shortPlanHash(row.planHash)}.json`
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="p-4">
    <div v-if="loading" class="space-y-2">
      <AtomsSkeleton v-for="i in 3" :key="i" variant="custom" class="h-16 w-full rounded-lg" />
    </div>
    <AtomsEmptyState
      v-else-if="rows.length === 0"
      icon="icon-[annon--file-text]"
      :title="t('receipts.empty_title')"
      :description="t('receipts.empty_description')"
    />
    <ul v-else class="space-y-2">
      <li
        v-for="row in rows"
        :key="row.id"
        class="rounded-lg border border-secondary-200 px-3 py-2 dark:border-secondary-800"
      >
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-heading dark:text-secondary-100">
              {{ row.target === 'release' ? t('receipts.target_release') : row.target }}
            </p>
            <p class="mt-0.5 text-[11px] text-muted">
              <span class="font-mono">{{ shortPlanHash(row.planHash) }}</span>
              <span aria-hidden="true"> · </span>
              <span>{{ formatRelativeTime(row.createdAt, t) }}</span>
              <template v-if="row.receipt.actor?.id">
                <span aria-hidden="true"> · </span>
                <span>{{ t('receipts.ran_by', { actor: row.receipt.actor.name ?? row.receipt.actor.id }) }}</span>
              </template>
            </p>
            <p v-if="scopeOf(row.receipt)" class="mt-0.5 truncate text-[11px] text-body dark:text-secondary-300">
              {{ scopeOf(row.receipt) }}
            </p>
            <p v-if="approversOf(row.receipt)" class="mt-0.5 truncate text-[11px] text-muted">
              {{ t('review.approval_signed_by', { names: approversOf(row.receipt) }) }}
            </p>
            <p v-else class="mt-0.5 text-[11px] text-muted">
              {{ t('receipts.no_approvals') }}
            </p>
          </div>
          <AtomsBaseButton type="button" variant="ghost" size="sm" @click="download(row)">
            <span class="icon-[annon--download] size-4" aria-hidden="true" />
            {{ t('receipts.export') }}
          </AtomsBaseButton>
        </div>
      </li>
    </ul>
  </div>
</template>
