<script setup lang="ts">
import { marked } from 'marked'

defineProps<{
  entries: Array<{ slug: string, frontmatter: Record<string, unknown>, body: string }>
}>()

const { sanitize } = useSanitize()
const getFieldType = inject<(fieldId: string) => string>('getFieldType', () => 'string')
const getUserFieldIds = inject<() => string[]>('getUserFieldIds', () => [])

function renderMarkdown(md: string): string {
  return sanitize(marked.parse(md, { async: false }) as string)
}
</script>

<template>
  <div>
    <div class="divide-y divide-secondary-100 dark:divide-secondary-800">
      <details
        v-for="doc in entries"
        :key="doc.slug"
        class="group"
      >
        <summary class="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900">
          <span class="icon-[annon--chevron-right] size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden="true" />
          <span class="icon-[annon--file-text] size-4 shrink-0 text-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate font-medium text-heading dark:text-secondary-100">
            {{ (doc.frontmatter.title as string) || doc.slug }}
          </span>
        </summary>
        <div class="space-y-3 px-5 pb-4 pt-1">
          <!-- Schema fields first -->
          <template v-for="fieldId in getUserFieldIds()" :key="fieldId">
            <div v-if="fieldId in doc.frontmatter">
              <AtomsSectionLabel :label="fieldId" class="px-0 py-0" />
              <div class="mt-0.5">
                <AtomsContentFieldDisplay :type="getFieldType(fieldId)" :value="doc.frontmatter[fieldId]" :field-id="fieldId" />
              </div>
            </div>
          </template>
          <!-- Extra frontmatter fields not in schema -->
          <template v-for="(value, key) in doc.frontmatter" :key="'extra-' + String(key)">
            <div v-if="!getUserFieldIds().includes(String(key))">
              <AtomsSectionLabel :label="String(key)" class="px-0 py-0" />
              <div class="mt-0.5">
                <AtomsContentFieldDisplay type="string" :value="value" :field-id="String(key)" />
              </div>
            </div>
          </template>
          <!-- Rendered markdown body -->
          <div v-if="doc.body">
            <AtomsSectionLabel label="body" class="px-0 py-0" />
            <div
              class="prose prose-sm prose-secondary mt-1 max-w-none rounded-lg bg-secondary-50 p-4 dark:prose-invert dark:bg-secondary-900"
              v-html="renderMarkdown(doc.body)"
            />
          </div>
        </div>
      </details>
    </div>
    <div class="border-t border-secondary-200 px-5 py-3 dark:border-secondary-800">
      <span class="text-xs text-muted">{{ entries.length }} documents</span>
    </div>
  </div>
</template>
