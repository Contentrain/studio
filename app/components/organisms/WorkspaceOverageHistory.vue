<script setup lang="ts">
const { t } = useContent()
const { activeWorkspace } = useWorkspaces()

const entries = ref<Array<{
  id: string
  billing_period: string
  category: string
  units_billed: number
  unit_price: number
  total_amount: number
  created_at: string
}>>([])
const loading = ref(false)

async function fetchHistory() {
  const ws = activeWorkspace.value
  if (!ws) return
  loading.value = true
  try {
    const data = await $fetch<{ entries: typeof entries.value }>(`/api/workspaces/${ws.id}/overage-history`)
    entries.value = data.entries
  }
  finally {
    loading.value = false
  }
}

onMounted(fetchHistory)

function formatCategory(key: string): string {
  const map: Record<string, string> = {
    ai_messages: 'AI Messages',
    api_messages: 'API Messages',
    cdn_bandwidth: 'CDN Bandwidth',
    form_submissions: 'Form Submissions',
    media_storage: 'Media Storage',
  }
  return map[key] ?? key
}
</script>

<template>
  <div v-if="entries.length > 0 || loading" class="space-y-3">
    <h4 class="text-sm font-medium text-heading dark:text-secondary-100">
      {{ t('billing.overage_history') }}
    </h4>

    <div v-if="loading" class="flex items-center justify-center py-4">
      <span class="icon-[annon--loader] size-4 animate-spin text-muted" />
    </div>

    <div v-else class="overflow-hidden rounded-lg border border-secondary-200 dark:border-secondary-800">
      <table class="w-full text-left text-sm">
        <thead class="bg-secondary-50 dark:bg-secondary-900">
          <tr>
            <th class="px-4 py-2 text-xs font-medium text-muted">
              {{ t('billing.period') }}
            </th>
            <th class="px-4 py-2 text-xs font-medium text-muted">
              {{ t('billing.category') }}
            </th>
            <th class="px-4 py-2 text-right text-xs font-medium text-muted">
              {{ t('billing.units') }}
            </th>
            <th class="px-4 py-2 text-right text-xs font-medium text-muted">
              {{ t('billing.amount') }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-secondary-200 dark:divide-secondary-800">
          <tr v-for="entry in entries" :key="entry.id">
            <td class="px-4 py-2 text-muted tabular-nums">
              {{ entry.billing_period }}
            </td>
            <td class="px-4 py-2 text-heading dark:text-secondary-100">
              {{ formatCategory(entry.category) }}
            </td>
            <td class="px-4 py-2 text-right tabular-nums text-muted">
              {{ entry.units_billed }}
            </td>
            <td class="px-4 py-2 text-right font-medium tabular-nums text-heading dark:text-secondary-100">
              ${{ entry.total_amount.toFixed(2) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
