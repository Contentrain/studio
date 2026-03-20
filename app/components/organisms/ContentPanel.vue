<script setup lang="ts">
import type { FieldDef } from '@contentrain/types'

interface SnapshotModel {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly type: string
  readonly fields: Readonly<Record<string, unknown>>
  readonly domain: string
  readonly i18n: boolean
}

interface SnapshotData {
  readonly exists: boolean
  readonly config: unknown
  readonly models: readonly SnapshotModel[]
  readonly content: Readonly<Record<string, { count: number, locales: string[] }>>
}

const props = defineProps<{
  snapshot: SnapshotData | null
  snapshotLoading: boolean
  modelContent: unknown
  modelContentKind: string
  modelContentLoading: boolean
  activeModelId: string | null
}>()

const emit = defineEmits<{
  selectModel: [modelId: string]
  back: []
}>()

const activeModel = computed(() =>
  props.snapshot?.models.find(m => m.id === props.activeModelId) ?? null,
)

const panelState = computed(() => props.activeModelId ? 'model' : 'overview')

// Schema-aware field utilities
function getFieldType(fieldId: string): string {
  if (!activeModel.value?.fields) return 'string'
  const fields = activeModel.value.fields as Record<string, FieldDef>
  return fields[fieldId]?.type ?? 'string'
}

function getPrimaryFieldId(): string | null {
  if (!activeModel.value?.fields) return null
  const fields = activeModel.value.fields as Record<string, FieldDef>
  for (const [key, def] of Object.entries(fields)) {
    if (def.required && (def.type === 'string' || def.type === 'slug')) return key
  }
  for (const [key, def] of Object.entries(fields)) {
    if (def.type === 'string' || def.type === 'slug') return key
  }
  return Object.keys(fields)[0] ?? null
}

function getEntryTitle(entry: Record<string, unknown>, fallback: string): string {
  const primaryField = getPrimaryFieldId()
  if (primaryField && typeof entry[primaryField] === 'string') return entry[primaryField] as string
  for (const value of Object.values(entry)) {
    if (typeof value === 'string' && value.length > 0 && value.length < 100) return value
  }
  return fallback
}

function getUserFieldIds(): string[] {
  if (!activeModel.value?.fields) return []
  return Object.keys(activeModel.value.fields as Record<string, unknown>)
}

// Provide utilities to child components
function arrayToObjectMap(arr: Record<string, unknown>[]): Record<string, Record<string, unknown>> {
  const map: Record<string, Record<string, unknown>> = {}
  arr.forEach((entry, idx) => {
    const id = (entry.id as string) ?? (entry.ID as string) ?? `entry-${idx}`
    map[id] = entry
  })
  return map
}

provide('getFieldType', getFieldType)
provide('getEntryTitle', getEntryTitle)
provide('getUserFieldIds', getUserFieldIds)
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex h-14 shrink-0 items-center gap-2 border-b border-secondary-200 px-5 dark:border-secondary-800">
      <AtomsIconButton
        v-if="panelState === 'model'"
        icon="icon-[annon--arrow-left]"
        label="Back"
        @click="emit('back')"
      />
      <h3 class="truncate text-sm font-semibold text-heading dark:text-secondary-100">
        {{ panelState === 'model' && activeModel ? activeModel.name : 'Content' }}
      </h3>
      <AtomsBadge v-if="panelState === 'model' && activeModel" variant="secondary" size="sm" class="ml-auto shrink-0">
        {{ activeModel.kind ?? activeModel.type }}
      </AtomsBadge>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      <!-- OVERVIEW -->
      <template v-if="panelState === 'overview'">
        <div v-if="snapshotLoading" class="space-y-2 p-5">
          <AtomsSkeleton v-for="i in 4" :key="i" variant="custom" class="h-10 w-full rounded-lg" />
        </div>
        <div v-else-if="!snapshot?.exists" class="p-5">
          <AtomsEmptyState icon="icon-[annon--folder-open]" title=".contentrain/ not found" description="Initialize content structure via chat in Phase 2." />
        </div>
        <OrganismsContentModelList
          v-else-if="snapshot && snapshot.models.length > 0"
          :models="snapshot.models"
          :content="snapshot.content"
          @select="emit('selectModel', $event)"
        />
        <div v-else class="p-5">
          <AtomsEmptyState icon="icon-[annon--box]" title="No models yet" description="Create models via chat in Phase 2." />
        </div>
      </template>

      <!-- MODEL CONTENT -->
      <template v-else-if="panelState === 'model'">
        <div v-if="modelContentLoading" class="space-y-3 p-5">
          <AtomsSkeleton v-for="i in 6" :key="i" variant="custom" class="h-12 w-full rounded-lg" />
        </div>
        <div v-else-if="!modelContent" class="p-5">
          <AtomsEmptyState icon="icon-[annon--file]" title="No content" description="This model has no content entries yet." />
        </div>
        <template v-else>
          <!-- Dictionary -->
          <OrganismsContentDictionaryView
            v-if="modelContentKind === 'dictionary' && typeof modelContent === 'object' && !Array.isArray(modelContent)"
            :content="(modelContent as Record<string, unknown>)"
          />
          <!-- Document -->
          <OrganismsContentDocumentView
            v-else-if="modelContentKind === 'document' && Array.isArray(modelContent)"
            :entries="(modelContent as Array<{ slug: string, frontmatter: Record<string, unknown>, body: string }>)"
          />
          <!-- Collection (object-map) -->
          <OrganismsContentCollectionView
            v-else-if="typeof modelContent === 'object' && !Array.isArray(modelContent)"
            :content="(modelContent as Record<string, Record<string, unknown>>)"
          />
          <!-- Collection (array) -->
          <OrganismsContentCollectionView
            v-else-if="Array.isArray(modelContent)"
            :content="arrayToObjectMap(modelContent as Record<string, unknown>[])"
          />
          <!-- Singleton -->
          <OrganismsContentSingletonView
            v-else-if="typeof modelContent === 'object'"
            :content="(modelContent as Record<string, unknown>)"
          />
        </template>
      </template>
    </div>
  </div>
</template>
