<script setup lang="ts">
import { activeModelMetaKey } from '~/utils/injection-keys'

const props = defineProps<{
  content: Record<string, unknown>
}>()

const { t } = useContent()
const searchQuery = ref('')
const modelMeta = inject(activeModelMetaKey, computed(() => null))
const { toggle, isPinned, startDrag, endDrag } = useChatContext()

const filteredEntries = computed(() => {
  const entries = Object.entries(props.content)
  if (!searchQuery.value) return entries
  const q = searchQuery.value.toLowerCase()
  return entries.filter(([key, value]) =>
    key.toLowerCase().includes(q) || String(value).toLowerCase().includes(q),
  )
})

function pinKey(e: Event, key: string, value: unknown) {
  e.stopPropagation()
  const meta = modelMeta.value
  if (!meta) return
  toggle({
    type: 'field',
    label: key,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    fieldId: key,
    data: value,
  })
}

function onRowDragStart(e: DragEvent, key: string, value: unknown) {
  const meta = modelMeta.value
  if (!meta) return
  startDrag(e, {
    type: 'field',
    label: key,
    sublabel: typeof value === 'string' ? value.substring(0, 40) : String(value),
    modelId: meta.id,
    modelName: meta.name,
    fieldId: key,
    data: value,
  })
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Search -->
    <div class="shrink-0 border-b border-secondary-200 px-5 py-2 dark:border-secondary-800">
      <AtomsFormInput v-model="searchQuery" type="search" :placeholder="t('content.filter_keys')" />
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
            <th class="w-8" />
          </tr>
        </thead>
        <tbody class="divide-y divide-secondary-100 dark:divide-secondary-800">
          <tr
            v-for="[key, value] in filteredEntries"
            :key="key"
            class="group hover:bg-secondary-50 dark:hover:bg-secondary-900"
            draggable="true"
            @dragstart="onRowDragStart($event, key, value)"
            @dragend="endDrag"
          >
            <td class="max-w-40 truncate px-5 py-2 font-mono text-xs text-muted" :title="key">
              {{ key }}
            </td>
            <td class="max-w-48 truncate px-5 py-2 text-heading dark:text-secondary-100" :title="String(value)">
              {{ String(value) }}
            </td>
            <td class="pr-3">
              <button
                type="button"
                class="shrink-0 rounded-md p-0.5 transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :class="isPinned('field', modelMeta?.id ?? '', undefined, key)
                  ? 'text-info-500 opacity-100'
                  : 'text-muted opacity-0 hover:opacity-100 group-hover:opacity-60'"
                @click="pinKey($event, key, value)"
              >
                <span class="icon-[annon--pin] size-2.5" aria-hidden="true" />
              </button>
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
