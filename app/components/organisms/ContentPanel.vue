<script setup lang="ts">
import type { FieldDef } from '@contentrain/types'
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'radix-vue'

const { t } = useContent()

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
  readonly vocabulary?: Readonly<Record<string, Record<string, string>>> | null
  readonly contentContext?: { lastOperation?: { tool?: string, model?: string, locale?: string, timestamp?: string }, stats?: { models?: number, entries?: number, locales?: string[] } } | null
}

interface BranchDiffData {
  branch: string
  files: Array<{ path: string, status: 'added' | 'modified' | 'removed' }>
  contents: Record<string, { before: unknown, after: unknown }>
}

const props = defineProps<{
  snapshot: SnapshotData | null
  snapshotLoading: boolean
  modelContent: unknown
  modelContentKind: string
  modelContentMeta?: Record<string, unknown> | null
  modelContentLoading: boolean
  activeModelId: string | null
  activeBranch?: string | null
  branchDiff?: BranchDiffData | null
  branchDiffLoading?: boolean
  canManageBranches?: boolean
  workspaceId?: string
  projectId?: string
  editable?: boolean
}>()

const emit = defineEmits<{
  'selectModel': [modelId: string]
  'back': []
  'update:locale': [locale: string]
  'sendChatPrompt': [text: string]
  'branchMerge': []
  'branchReject': []
}>()

// Locale from config
const supportedLocales = computed(() => {
  const config = props.snapshot?.config as { locales?: { supported?: string[], default?: string } } | null
  return config?.locales?.supported ?? ['en']
})

const currentLocale = defineModel<string>('locale', { default: 'en' })

const activeModel = computed(() =>
  props.snapshot?.models.find(m => m.id === props.activeModelId) ?? null,
)

const panelState = computed(() => {
  if (props.activeBranch) return 'branch'
  if (props.activeModelId) return 'model'
  return 'overview'
})

function branchDisplayName(branch: string): string {
  return branch.replace('contentrain/', '')
}

// Project stats from context.json or computed from snapshot
const stats = computed(() => {
  if (!props.snapshot?.exists) return null
  const ctx = props.snapshot.contentContext?.stats
  return {
    models: ctx?.models ?? props.snapshot.models.length,
    entries: ctx?.entries ?? Object.values(props.snapshot.content).reduce((sum, c) => sum + c.count, 0),
    locales: ctx?.locales ?? [],
  }
})

// Vocabulary terms
const vocabularyTerms = computed(() => {
  const vocab = props.snapshot?.vocabulary
  if (!vocab) return []
  return Object.entries(vocab)
})

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

// Model metadata for context chips
const activeModelMeta = computed(() => activeModel.value
  ? { id: activeModel.value.id, name: activeModel.value.name, kind: activeModel.value.kind }
  : null,
)

function getModelFields(): Record<string, unknown> {
  return (activeModel.value?.fields ?? {}) as Record<string, unknown>
}

function sendChatPrompt(text: string) {
  emit('sendChatPrompt', text)
}

function addEntry() {
  if (!activeModel.value) return
  sendChatPrompt(`Create a new entry for the ${activeModel.value.name} model with default values.`)
}

function deleteModel() {
  if (!activeModel.value) return
  sendChatPrompt(`Delete the ${activeModel.value.name} model (ID: ${activeModel.value.id}) and all its content.`)
}

function addModel() {
  sendChatPrompt('Create a new content model. Ask me what kind of content I want to manage.')
}

provide('getFieldType', getFieldType)
provide('getEntryTitle', getEntryTitle)
provide('getUserFieldIds', getUserFieldIds)
provide('activeModelMeta', activeModelMeta)
provide('getModelFields', getModelFields)
provide('sendChatPrompt', sendChatPrompt)
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex h-14 shrink-0 items-center gap-2 border-b border-secondary-200 px-5 dark:border-secondary-800">
      <AtomsIconButton
        v-if="panelState === 'model' || panelState === 'branch'" icon="icon-[annon--arrow-left]" :label="t('common.back')"
        @click="emit('back')"
      />
      <h3 class="flex-1 truncate text-sm font-semibold text-heading dark:text-secondary-100">
        <template v-if="panelState === 'branch' && activeBranch">
          {{ branchDisplayName(activeBranch) }}
        </template>
        <template v-else-if="panelState === 'model' && activeModel">
          {{ activeModel.name }}
        </template>
        <template v-else>
          {{ t('content.title') }}
        </template>
      </h3>
      <!-- Branch badge -->
      <AtomsBadge v-if="panelState === 'branch'" variant="warning" size="sm" class="ml-auto">
        <span class="icon-[annon--arrow-swap] mr-1 size-3" aria-hidden="true" />
        review
      </AtomsBadge>
      <!-- Overview actions -->
      <div v-if="panelState === 'overview' && editable && snapshot?.exists" class="ml-auto">
        <AtomsIconButton
          icon="icon-[annon--plus]"
          :label="t('content.add_model')"
          size="sm"
          @click="addModel"
        />
      </div>
      <div v-if="panelState === 'model'" class="ml-auto flex shrink-0 items-center gap-2">
        <!-- Add entry (collection only) -->
        <AtomsIconButton
          v-if="editable && activeModel && (activeModel.kind === 'collection' || activeModel.type === 'collection')"
          icon="icon-[annon--plus]"
          :label="t('content.add_entry')"
          size="sm"
          @click="addEntry"
        />
        <!-- Delete model -->
        <AtomsIconButton
          v-if="editable && activeModel"
          icon="icon-[annon--trash]"
          :label="t('content.delete_model')"
          size="sm"
          @click="deleteModel"
        />
        <!-- Locale switcher -->
        <AtomsFormSelect
          v-if="supportedLocales.length > 1" :model-value="currentLocale"
          :options="supportedLocales.map(l => ({ value: l, label: l.toUpperCase() }))" size="sm"
          @update:model-value="currentLocale = $event"
        />
        <AtomsBadge v-if="activeModel" variant="secondary" size="sm">
          {{ activeModel.kind ?? activeModel.type }}
        </AtomsBadge>
      </div>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      <!-- BRANCH DIFF -->
      <template v-if="panelState === 'branch'">
        <div v-if="branchDiffLoading" class="space-y-3 p-5">
          <AtomsSkeleton v-for="i in 4" :key="i" variant="custom" class="h-12 w-full rounded-lg" />
        </div>
        <OrganismsBranchDetailView
          v-else-if="branchDiff"
          :diff="branchDiff"
          :can-manage="canManageBranches ?? false"
          @merge="emit('branchMerge')"
          @reject="emit('branchReject')"
        />
        <div v-else class="p-5">
          <AtomsEmptyState icon="icon-[annon--arrow-swap]" :title="t('branch.no_changes')" />
        </div>
      </template>

      <!-- OVERVIEW -->
      <template v-else-if="panelState === 'overview'">
        <div v-if="snapshotLoading" class="space-y-2 p-5">
          <AtomsSkeleton v-for="i in 4" :key="i" variant="custom" class="h-10 w-full rounded-lg" />
        </div>
        <div v-else-if="!snapshot?.exists" class="p-5">
          <AtomsEmptyState
            icon="icon-[annon--folder-open]" :title="t('content.not_found_title')"
            :description="t('content.not_found_description')"
          />
        </div>
        <template v-else-if="snapshot && snapshot.models.length > 0">
          <!-- Project stats bar -->
          <TooltipProvider v-if="stats" :delay-duration="300">
            <div class="flex items-center gap-3 border-b border-secondary-100 px-5 py-2.5 dark:border-secondary-800/50">
              <TooltipRoot>
                <TooltipTrigger as-child>
                  <div class="flex items-center gap-1.5 text-xs text-muted">
                    <span class="icon-[annon--layers] size-3.5" aria-hidden="true" />
                    <span class="font-medium">{{ stats.models }}</span>
                  </div>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent
                    :side-offset="6"
                    class="z-50 rounded-lg bg-secondary-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-secondary-100 dark:text-secondary-900"
                  >
                    {{ stats.models }} {{ stats.models === 1 ? 'model' : 'models' }}
                    <TooltipArrow class="fill-secondary-900 dark:fill-secondary-100" />
                  </TooltipContent>
                </TooltipPortal>
              </TooltipRoot>

              <TooltipRoot>
                <TooltipTrigger as-child>
                  <div class="flex items-center gap-1.5 text-xs text-muted">
                    <span class="icon-[annon--file-text] size-3.5" aria-hidden="true" />
                    <span class="font-medium">{{ stats.entries }}</span>
                  </div>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent
                    :side-offset="6"
                    class="z-50 rounded-lg bg-secondary-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-secondary-100 dark:text-secondary-900"
                  >
                    {{ stats.entries }} {{ stats.entries === 1 ? 'entry' : 'entries' }}
                    <TooltipArrow class="fill-secondary-900 dark:fill-secondary-100" />
                  </TooltipContent>
                </TooltipPortal>
              </TooltipRoot>

              <TooltipRoot v-if="stats.locales.length > 0">
                <TooltipTrigger as-child>
                  <div class="flex items-center gap-1.5 text-xs text-muted">
                    <span class="icon-[annon--globe] size-3.5" aria-hidden="true" />
                    <span class="font-medium">{{ stats.locales.map(l => l.toUpperCase()).join(', ') }}</span>
                  </div>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent
                    :side-offset="6"
                    class="z-50 rounded-lg bg-secondary-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-secondary-100 dark:text-secondary-900"
                  >
                    {{ stats.locales.length }} {{ stats.locales.length === 1 ? 'locale' : 'locales' }}: {{ stats.locales.join(', ') }}
                    <TooltipArrow class="fill-secondary-900 dark:fill-secondary-100" />
                  </TooltipContent>
                </TooltipPortal>
              </TooltipRoot>
            </div>
          </TooltipProvider>

          <!-- Model list -->
          <OrganismsContentModelList
            :models="snapshot.models"
            :content="snapshot.content" @select="emit('selectModel', $event)"
          />

          <!-- Vocabulary section -->
          <div v-if="vocabularyTerms.length > 0" class="border-t border-secondary-200 dark:border-secondary-800">
            <details class="group">
              <summary class="flex items-center gap-2 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900">
                <span class="icon-[annon--book-library] size-3.5" aria-hidden="true" />
                <span>{{ t('content.vocabulary') }}</span>
                <AtomsBadge variant="secondary" size="sm" class="ml-auto">
                  {{ vocabularyTerms.length }}
                </AtomsBadge>
                <span class="icon-[annon--chevron-right] size-3 transition-transform group-open:rotate-90" aria-hidden="true" />
              </summary>
              <div class="max-h-48 overflow-y-auto">
                <table class="w-full text-xs">
                  <tbody class="divide-y divide-secondary-100 dark:divide-secondary-800">
                    <tr
                      v-for="[term, translations] in vocabularyTerms"
                      :key="term"
                      class="hover:bg-secondary-50 dark:hover:bg-secondary-900"
                    >
                      <td class="px-5 py-1.5 font-mono text-muted">
                        {{ term }}
                      </td>
                      <td class="px-2 py-1.5 text-heading dark:text-secondary-100">
                        {{ translations[currentLocale] ?? (Object.keys(translations).length > 0 ? translations[Object.keys(translations)[0]!] : '') }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </template>
        <div v-else class="p-5">
          <AtomsEmptyState
            icon="icon-[annon--box]" :title="t('content.no_models_title')"
            :description="t('content.no_models_description')"
          />
        </div>
      </template>

      <!-- MODEL CONTENT -->
      <template v-else-if="panelState === 'model'">
        <div v-if="modelContentLoading" class="space-y-3 p-5">
          <AtomsSkeleton v-for="i in 6" :key="i" variant="custom" class="h-12 w-full rounded-lg" />
        </div>
        <div v-else-if="!modelContent" class="p-5">
          <AtomsEmptyState
            icon="icon-[annon--file]" :title="t('content.no_content_title')"
            :description="t('content.no_content_description')"
          />
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
            v-else-if="modelContentKind === 'collection' && typeof modelContent === 'object' && !Array.isArray(modelContent)"
            :content="(modelContent as Record<string, Record<string, unknown>>)" :meta="modelContentMeta"
            :workspace-id="workspaceId" :project-id="projectId" :model-id="activeModelId ?? undefined"
            :locale="currentLocale" :editable="editable" @saved="emit('back')"
          />
          <!-- Collection (array) -->
          <OrganismsContentCollectionView
            v-else-if="Array.isArray(modelContent)"
            :content="arrayToObjectMap(modelContent as Record<string, unknown>[])" :workspace-id="workspaceId"
            :project-id="projectId" :model-id="activeModelId ?? undefined" :locale="currentLocale" :editable="editable"
            @saved="emit('back')"
          />
          <!-- Singleton -->
          <OrganismsContentSingletonView
            v-else-if="typeof modelContent === 'object'"
            :content="(modelContent as Record<string, unknown>)" :workspace-id="workspaceId" :project-id="projectId"
            :model-id="activeModelId ?? undefined" :locale="currentLocale" :editable="editable" @saved="emit('back')"
          />
        </template>
      </template>
    </div>
  </div>
</template>
