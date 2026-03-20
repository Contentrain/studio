<script setup lang="ts">
defineProps<{
  content: Record<string, Record<string, unknown>>
}>()

const getFieldType = inject<(fieldId: string) => string>('getFieldType', () => 'string')
const getEntryTitle = inject<(entry: Record<string, unknown>, fallback: string) => string>('getEntryTitle', (_e, f) => f)
const getUserFieldIds = inject<() => string[]>('getUserFieldIds', () => [])
</script>

<template>
  <div>
    <div class="divide-y divide-secondary-100 dark:divide-secondary-800">
      <details
        v-for="(entry, entryId) in content"
        :key="String(entryId)"
        class="group"
      >
        <summary class="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900">
          <span class="icon-[annon--chevron-right] size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate font-medium text-heading dark:text-secondary-100">
            {{ getEntryTitle(entry, String(entryId)) }}
          </span>
          <span class="shrink-0 font-mono text-[10px] text-disabled">
            {{ String(entryId).substring(0, 8) }}
          </span>
        </summary>
        <div class="space-y-3 px-5 pb-4 pt-1">
          <template v-for="fieldId in getUserFieldIds()" :key="fieldId">
            <div v-if="typeof entry === 'object' && entry !== null && fieldId in entry">
              <AtomsSectionLabel :label="fieldId" class="px-0 py-0" />
              <div class="mt-0.5">
                <AtomsContentFieldDisplay :type="getFieldType(fieldId)" :value="entry[fieldId]" :field-id="fieldId" />
              </div>
            </div>
          </template>
          <div class="border-t border-secondary-100 pt-2 dark:border-secondary-800">
            <AtomsSectionLabel label="ID" class="px-0 py-0" />
            <span class="font-mono text-xs text-disabled">{{ String(entryId) }}</span>
          </div>
        </div>
      </details>
    </div>
    <div class="border-t border-secondary-200 px-5 py-3 dark:border-secondary-800">
      <span class="text-xs text-muted">{{ Object.keys(content).length }} entries</span>
    </div>
  </div>
</template>
