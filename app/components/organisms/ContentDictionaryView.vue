<script setup lang="ts">
const props = defineProps<{
  content: Record<string, unknown>
}>()

const { t } = useContent()
const searchQuery = ref('')

const filteredEntries = computed(() => {
  const entries = Object.entries(props.content)
  if (!searchQuery.value) return entries
  const q = searchQuery.value.toLowerCase()
  return entries.filter(([key, value]) =>
    key.toLowerCase().includes(q) || String(value).toLowerCase().includes(q),
  )
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Search -->
    <div class="shrink-0 border-b border-secondary-200 px-5 py-2 dark:border-secondary-800">
      <div class="relative">
        <span class="icon-[annon--search] absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input
          v-model="searchQuery"
          type="search"
          :placeholder="t('content.filter_keys')"
          class="w-full rounded-md border border-secondary-200 bg-white py-1.5 pl-8 pr-3 text-xs text-heading placeholder:text-muted focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-secondary-800 dark:bg-secondary-900 dark:text-secondary-100"
        >
      </div>
    </div>

    <!-- Table -->
    <div class="flex-1 overflow-y-auto">
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-white dark:bg-secondary-950">
          <tr class="border-b border-secondary-200 dark:border-secondary-800">
            <th class="px-5 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted">
              {{ t('content.key_column') }}
            </th>
            <th class="px-5 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted">
              {{ t('content.value_column') }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-secondary-100 dark:divide-secondary-800">
          <tr
            v-for="[key, value] in filteredEntries"
            :key="key"
            class="hover:bg-secondary-50 dark:hover:bg-secondary-900"
          >
            <td class="max-w-40 truncate px-5 py-2 font-mono text-xs text-muted" :title="key">
              {{ key }}
            </td>
            <td class="max-w-48 truncate px-5 py-2 text-heading dark:text-secondary-100" :title="String(value)">
              {{ String(value) }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="filteredEntries.length === 0" class="p-5">
        <AtomsEmptyState icon="icon-[annon--search]" :title="t('content.no_matches_title')" :description="t('content.no_matches_description')" />
      </div>
    </div>

    <!-- Footer -->
    <div class="shrink-0 border-t border-secondary-200 px-5 py-2 dark:border-secondary-800">
      <span class="text-xs text-muted">
        {{ filteredEntries.length }}{{ searchQuery ? ` / ${Object.keys(content).length}` : '' }} {{ t('content.keys_count') }}
      </span>
    </div>
  </div>
</template>
