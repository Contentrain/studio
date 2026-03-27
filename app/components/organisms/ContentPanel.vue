<script setup lang="ts">
import type { DeepReadonly } from 'vue'
import type { FieldDef } from '@contentrain/types'
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'radix-vue'
import { activeModelMetaKey, getEntryTitleKey, getFieldTypeKey, getModelFieldsKey, getUserFieldIdsKey, sendChatPromptKey } from '~/utils/injection-keys'

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

const modelSubTab = ref<'content' | 'submissions'>('content')

// Reset sub-tab when model changes
watch(() => props.activeModelId, () => {
  modelSubTab.value = 'content'
})

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

// Vocabulary editing
const vocabNewKey = ref('')
const vocabNewValue = ref('')

function vocabDeleteTerm(key: string) {
  emit('vocabularySave', { [key]: null })
}

function vocabAddTerm() {
  const key = vocabNewKey.value.trim()
  const value = vocabNewValue.value.trim()
  if (!key || !value) return
  emit('vocabularySave', { [key]: { [currentLocale.value]: value } })
  vocabNewKey.value = ''
  vocabNewValue.value = ''
}

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
      <AtomsHealthScoreBadge v-if="panelState === 'health'" :score="healthScore" size="sm" class="ml-auto" />
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
        <div v-if="vocabularyTerms.length === 0 && !editable" class="p-5">
          <AtomsEmptyState
            icon="icon-[annon--book-library]"
            :title="t('content.vocabulary_empty_title')"
            :description="t('content.vocabulary_empty_description')"
          />
        </div>
        <template v-else>
          <div class="divide-y divide-secondary-100 dark:divide-secondary-800">
            <div
              v-for="[term, translations] in vocabularyTerms"
              :key="term"
              class="group/row flex items-center gap-3 px-5 py-2.5 hover:bg-secondary-50 dark:hover:bg-secondary-900"
            >
              <div class="min-w-0 flex-1">
                <div class="font-mono text-xs font-medium text-label">
                  {{ term }}
                </div>
                <div class="mt-0.5 text-sm text-heading dark:text-secondary-100">
                  {{ translations[currentLocale] ?? (Object.keys(translations).length > 0 ? translations[Object.keys(translations)[0]!] : '—') }}
                </div>
                <div v-if="Object.keys(translations).length > 1" class="mt-0.5 flex gap-1.5">
                  <span
                    v-for="(val, loc) in translations"
                    :key="loc"
                    class="text-[10px] text-muted"
                    :class="{ 'font-medium text-primary-500': loc === currentLocale }"
                  >
                    {{ String(loc).toUpperCase() }}
                  </span>
                </div>
              </div>
              <button
                v-if="editable"
                type="button"
                class="shrink-0 rounded p-1 text-muted opacity-0 transition-[color,opacity] hover:text-danger-500 group-hover/row:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :title="t('vocabulary.delete_term')"
                @click="vocabDeleteTerm(term)"
              >
                <span class="icon-[annon--trash] block size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
          <!-- Add term -->
          <div v-if="editable" class="sticky bottom-0 border-t border-secondary-200 bg-white px-5 py-3 dark:border-secondary-800 dark:bg-secondary-950">
            <form class="flex items-center gap-2" @submit.prevent="vocabAddTerm">
              <input
                v-model="vocabNewKey"
                type="text"
                :placeholder="t('vocabulary.key_placeholder')"
                class="h-8 w-24 shrink-0 rounded-lg border border-secondary-200 bg-white px-2.5 text-xs font-mono text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
              >
              <input
                v-model="vocabNewValue"
                type="text"
                :placeholder="t('vocabulary.value_placeholder')"
                class="h-8 flex-1 rounded-lg border border-secondary-200 bg-white px-2.5 text-sm text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
              >
              <AtomsBaseButton
                type="submit"
                variant="primary"
                size="sm"
                :disabled="!vocabNewKey.trim() || !vocabNewValue.trim()"
              >
                <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
              </AtomsBaseButton>
            </form>
          </div>
        </template>
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

              <!-- Health score -->
              <TooltipRoot>
                <TooltipTrigger as-child>
                  <button type="button" class="ml-auto" @click="emit('selectModel', '__health__')">
                    <AtomsHealthScoreBadge :score="healthScore" size="sm" />
                  </button>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent
                    :side-offset="6"
                    class="z-50 rounded-lg bg-secondary-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-secondary-100 dark:text-secondary-900"
                  >
                    {{ t('health.score_label') }}: {{ healthScore }}/100
                    <TooltipArrow class="fill-secondary-900 dark:fill-secondary-100" />
                  </TooltipContent>
                </TooltipPortal>
              </TooltipRoot>
            </div>
          </TooltipProvider>

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
        <!-- Form-enabled: tab switcher -->
        <div v-if="isFormEnabled" class="flex items-center gap-1 border-b border-secondary-200 px-5 dark:border-secondary-800">
          <button
            type="button"
            class="border-b-2 px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :class="modelSubTab === 'content'
              ? 'border-primary-500 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-muted hover:text-body'"
            @click="modelSubTab = 'content'"
          >
            {{ t('forms.tab_content') }}
          </button>
          <button
            type="button"
            class="border-b-2 px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :class="modelSubTab === 'submissions'
              ? 'border-primary-500 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-muted hover:text-body'"
            @click="modelSubTab = 'submissions'"
          >
            {{ t('forms.tab_submissions') }}
          </button>
        </div>

        <!-- Submissions tab -->
        <OrganismsSubmissionListView
          v-if="isFormEnabled && modelSubTab === 'submissions' && workspaceId && projectId && activeModelId"
          :workspace-id="workspaceId"
          :project-id="projectId"
          :model-id="activeModelId"
          :editable="editable"
        />

        <!-- Content tab (default) -->
        <template v-else-if="modelSubTab === 'content' || !isFormEnabled">
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
      </template>
    </div>
  </div>
</template>
