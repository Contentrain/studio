<script setup lang="ts">
import type { DeepReadonly } from 'vue'
import type { FieldDef } from '@contentrain/types'
import { activeModelMetaKey, getEntryTitleKey, getFieldTypeKey, getModelFieldsKey, getUserFieldIdsKey, sendChatPromptKey } from '~/utils/injection-keys'

interface SnapshotModel {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly type: string
  readonly fields: Record<string, unknown> | Readonly<Record<string, unknown>>
  readonly domain: string
  readonly i18n: boolean
}

// Accept both mutable and DeepReadonly variants from useSnapshot
type SnapshotData = {
  exists: boolean
  config: unknown
  models: readonly SnapshotModel[]
  content: Record<string, { count: number, locales: readonly string[] }>
  vocabulary?: Record<string, Record<string, string>> | null
  contentContext?: { lastOperation?: { tool?: string, model?: string, locale?: string, timestamp?: string }, stats?: { models?: number, entries?: number, locales?: string[] } } | null
}

type BranchDiffProps = {
  branch: string
  files: readonly { path: string, status: 'added' | 'modified' | 'removed' }[]
  contents: Record<string, { before: unknown, after: unknown }>
}

const props = defineProps<{
  snapshot: DeepReadonly<SnapshotData> | SnapshotData | null
  snapshotLoading: boolean
  modelContent: unknown
  modelContentKind: string
  modelContentMeta?: Record<string, unknown> | null
  modelContentLoading: boolean
  activeModelId: string | null
  activeBranch?: string | null
  activeVocabulary?: boolean
  activeCdn?: boolean
  activeAssets?: boolean
  activeHealth?: boolean
  branchDiff?: DeepReadonly<BranchDiffProps> | BranchDiffProps | null
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
  'vocabularySave': [terms: Record<string, Record<string, string> | null>]
}>()

const { t } = useContent()
const { healthScore, hasIssues, criticalCount, errorCount, warningCount } = useProjectHealth()
const brain = useContentBrain()

// Check if active model has form enabled (form config is on raw model definition)
const isFormEnabled = computed(() => {
  if (!props.activeModelId) return false
  const rawModel = brain.models.value.find(m => m.id === props.activeModelId)
  if (!rawModel) return false
  const form = (rawModel as unknown as { form?: { enabled?: boolean } }).form
  return form?.enabled === true
})

// Check if active model is a collection (only collections can have forms)
const isCollection = computed(() => {
  if (!activeModel.value) return false
  return activeModel.value.kind === 'collection' || activeModel.value.type === 'collection'
})

const modelSubTab = ref<'content' | 'submissions' | 'form'>('content')

// Reset sub-tab when model changes
watch(() => props.activeModelId, () => {
  modelSubTab.value = 'content'
})

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
  if (props.activeVocabulary) return 'vocabulary'
  if (props.activeCdn) return 'cdn'
  if (props.activeAssets) return 'assets'
  if (props.activeHealth) return 'health'
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

provide(getFieldTypeKey, getFieldType)
provide(getEntryTitleKey, getEntryTitle)
provide(getUserFieldIdsKey, getUserFieldIds)
provide(activeModelMetaKey, activeModelMeta)
provide(getModelFieldsKey, getModelFields)
provide(sendChatPromptKey, sendChatPrompt)
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex h-14 shrink-0 items-center gap-2 border-b border-secondary-200 px-5 dark:border-secondary-800">
      <AtomsIconButton
        v-if="panelState === 'model' || panelState === 'branch' || panelState === 'vocabulary' || panelState === 'cdn' || panelState === 'assets' || panelState === 'health'" icon="icon-[annon--arrow-left]" :label="t('common.back')"
        @click="emit('back')"
      />
      <AtomsHeadingText :level="3" size="xs" truncate class="flex-1">
        <template v-if="panelState === 'branch' && activeBranch">
          {{ branchDisplayName(activeBranch) }}
        </template>
        <template v-else-if="panelState === 'cdn'">
          {{ t('cdn.title') }}
        </template>
        <template v-else-if="panelState === 'assets'">
          {{ t('media.title') }}
        </template>
        <template v-else-if="panelState === 'health'">
          {{ t('health.title') }}
        </template>
        <template v-else-if="panelState === 'vocabulary'">
          {{ t('content.vocabulary') }}
        </template>
        <template v-else-if="panelState === 'model' && activeModel">
          {{ activeModel.name }}
        </template>
        <template v-else>
          {{ t('content.title') }}
        </template>
      </AtomsHeadingText>
      <!-- Vocabulary header: locale + count -->
      <template v-if="panelState === 'vocabulary'">
        <AtomsBadge variant="secondary" size="sm" class="ml-auto">
          {{ vocabularyTerms.length }}
        </AtomsBadge>
        <AtomsFormSelect
          v-if="supportedLocales.length > 1"
          :model-value="currentLocale"
          :options="supportedLocales.map(l => ({ value: l, label: l.toUpperCase() }))"
          size="sm"
          @update:model-value="currentLocale = $event"
        />
      </template>
      <!-- Health score in header -->
      <AtomsHealthScoreBadge v-if="panelState === 'health' && healthScore !== null" :score="healthScore" size="sm" class="ml-auto" />
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
        <!-- Add entry (collection / document) -->
        <AtomsIconButton
          v-if="editable && activeModel && (activeModel.kind === 'collection' || activeModel.type === 'collection' || activeModel.kind === 'document' || activeModel.type === 'document')"
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

      <!-- CDN -->
      <template v-else-if="panelState === 'cdn'">
        <OrganismsCDNPanel
          v-if="workspaceId && projectId"
          :workspace-id="workspaceId"
          :project-id="projectId"
        />
      </template>

      <!-- ASSETS -->
      <template v-else-if="panelState === 'assets'">
        <OrganismsAssetManager
          v-if="workspaceId && projectId"
          :workspace-id="workspaceId"
          :project-id="projectId"
          :editable="editable"
        />
      </template>

      <!-- VOCABULARY -->
      <template v-else-if="panelState === 'vocabulary'">
        <OrganismsContentVocabularyView
          :terms="vocabularyTerms"
          :locale="currentLocale"
          :editable="editable"
          @save="emit('vocabularySave', $event)"
        />
      </template>

      <!-- HEALTH DASHBOARD -->
      <template v-else-if="panelState === 'health'">
        <OrganismsProjectHealthDashboard
          v-if="workspaceId && projectId"
          :workspace-id="workspaceId"
          :project-id="projectId"
          @back="emit('back')"
          @send-chat-prompt="emit('sendChatPrompt', $event)"
        />
      </template>

      <!-- OVERVIEW -->
      <template v-else-if="panelState === 'overview'">
        <div v-if="snapshotLoading || !snapshot" class="space-y-2 p-5">
          <AtomsSkeleton variant="custom" class="h-8 w-full rounded-lg" />
          <AtomsSkeleton v-for="i in 4" :key="i" variant="custom" class="h-14 w-full rounded-lg" />
        </div>
        <div v-else-if="!snapshot.exists" class="p-5">
          <AtomsEmptyState
            illustration="/illustrations/initialize-project.png"
            :title="t('content.not_found_title')"
            :description="t('content.not_found_description')"
          />
        </div>
        <template v-else-if="snapshot && snapshot.models.length > 0">
          <!-- Project stats bar -->
          <MoleculesContentStatsBar
            v-if="stats"
            :model-count="stats.models"
            :entry-count="stats.entries"
            :locales="stats.locales"
            :health-score="healthScore ?? 0"
            @view-health="emit('selectModel', '__health__')"
          />

          <!-- Schema warning banner -->
          <MoleculesSchemaWarningBanner
            v-if="hasIssues"
            :critical-count="criticalCount"
            :error-count="errorCount"
            :warning-count="warningCount"
            @view-details="emit('selectModel', '__health__')"
            @dismiss="() => {}"
          />

          <!-- Model list -->
          <OrganismsContentModelList
            :models="snapshot.models"
            :content="snapshot.content" @select="emit('selectModel', $event)"
          />
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
        <!-- Tab switcher: Content + Form (collections) + Submissions (form enabled) -->
        <AtomsTabBar
          v-if="isCollection"
          v-model="modelSubTab"
          :tabs="[
            { value: 'content', label: t('forms.tab_content') },
            ...(isFormEnabled ? [{ value: 'submissions' as const, label: t('forms.tab_submissions') }] : []),
            { value: 'form', label: t('forms.tab_form_settings') },
          ]"
        />

        <!-- Submissions tab -->
        <OrganismsSubmissionListView
          v-if="isFormEnabled && modelSubTab === 'submissions' && workspaceId && projectId && activeModelId"
          :workspace-id="workspaceId"
          :project-id="projectId"
          :model-id="activeModelId"
          :editable="editable"
        />

        <!-- Form settings tab -->
        <OrganismsFormConfigSection
          v-else-if="modelSubTab === 'form' && workspaceId && projectId && activeModelId"
          :workspace-id="workspaceId"
          :project-id="projectId"
          :model-id="activeModelId"
          :editable="editable"
        />

        <!-- Content tab (default) -->
        <template v-else-if="modelSubTab === 'content' || !isCollection">
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
              :workspace-id="workspaceId" :project-id="projectId" :model-id="activeModelId ?? undefined"
              :locale="currentLocale" :editable="editable" @saved="emit('back')"
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
      </template>
    </div>
  </div>
</template>
