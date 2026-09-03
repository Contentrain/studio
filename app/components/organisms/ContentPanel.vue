<script setup lang="ts">
import type { DeepReadonly } from 'vue'
import type { FieldDef } from '@contentrain/types'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'radix-vue'
import type { BranchReview } from '~~/shared/utils/branch-review'
import type { BranchRawDiff } from '~/composables/useBranches'
import { fieldLabel, orderedFieldIds } from '~~/shared/utils/field-label'
import { activeModelMetaKey, getEntryTitleKey, getFieldLabelKey, getFieldTypeKey, getModelFieldsKey, getUserFieldIdsKey, relationLabelsKey, sendChatPromptKey } from '~/utils/injection-keys'

interface SnapshotModel {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly type: string
  readonly fields: Record<string, unknown> | Readonly<Record<string, unknown>>
  readonly domain: string
  readonly i18n: boolean
  readonly title_field?: string
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
  branchReview?: DeepReadonly<BranchReview> | BranchReview | null
  branchReviewLoading?: boolean
  branchRaw?: DeepReadonly<BranchRawDiff> | BranchRawDiff | null
  branchRawLoading?: boolean
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
  'branchLoadRaw': []
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

// Comments config lives next to `form` on the raw model definition
const isCommentsEnabled = computed(() => {
  if (!props.activeModelId) return false
  const rawModel = brain.models.value.find(m => m.id === props.activeModelId)
  if (!rawModel) return false
  const comments = (rawModel as unknown as { comments?: { enabled?: boolean } }).comments
  return comments?.enabled === true
})

// Collections and documents carry entries, so they can carry threads
const supportsComments = computed(() => {
  if (!activeModel.value) return false
  const kind = activeModel.value.kind ?? activeModel.value.type
  return kind === 'collection' || kind === 'document'
})

const modelSubTab = ref<'content' | 'submissions' | 'form' | 'comments' | 'comment-settings'>('content')

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

// One load per model/locale for every surface beneath: the collection rows,
// the singleton and document views, the filter axes. Before this the
// collection view loaded them for its filters alone and the read views
// printed relation refs raw.
const { relationLabels } = useRelationLabels(activeModel, currentLocale)

const panelState = computed(() => {
  if (props.activeBranch) return 'branch'
  if (props.activeVocabulary) return 'vocabulary'
  if (props.activeCdn) return 'cdn'
  if (props.activeAssets) return 'assets'
  if (props.activeHealth) return 'health'
  if (props.activeModelId) return 'model'
  return 'overview'
})

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

// ── Title field picker ─────────────────────────────────────
// Written through a direct PATCH rather than the chat agent, unlike the other
// actions in this header. An MCP write takes ~18s; a radio button that stays
// unconfirmed that long reads as broken. The chat path still works — the agent
// calls `contentrain_model_save` — so nothing is lost by not routing through it.
const titleFieldOpen = ref(false)
const titleFieldSaving = ref(false)
const titleFieldError = ref('')

const titleFieldChoices = computed(() => titleFieldOptions(activeModel.value))
const currentTitleField = computed(() => resolveTitleFieldId(activeModel.value))

async function setTitleField(field: string) {
  if (!props.workspaceId || !props.projectId || !props.activeModelId) return
  if (field === activeModel.value?.title_field) {
    titleFieldOpen.value = false
    return
  }

  titleFieldSaving.value = true
  titleFieldError.value = ''
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/models/${props.activeModelId}`, {
      method: 'PATCH',
      body: { titleField: field },
    })
    // The list titles read from the brain, so it has to be re-synced before the
    // change is visible. The endpoint invalidates the server cache; this drops
    // the client's copy and pulls the new definition back down — the same pair
    // the project page uses after a merge.
    await brain.invalidate(props.projectId)
    await brain.sync(props.workspaceId, props.projectId)
    titleFieldOpen.value = false
  }
  catch {
    titleFieldError.value = t('content.title_field_error')
  }
  finally {
    titleFieldSaving.value = false
  }
}

// The model now declares which field titles its entries. The old guess ranked
// `slug` alongside `string`, which is why articles listed by slug; it lives on
// as a fallback in shared/utils/entry-title.ts, shared with relation labels so
// one entry cannot be titled two different ways in two places.
function getEntryTitle(entry: Record<string, unknown>, fallback: string): string {
  return resolveEntryTitle(entry, activeModel.value, fallback)
}

function getUserFieldIds(): string[] {
  return orderedFieldIds(activeModel.value?.fields as Record<string, unknown> | undefined)
}

/**
 * What a field is called. Models have carried `FieldDef.label` since types 1.x;
 * until now every surface showed the raw id, which is why an editor saw
 * `is_category_hero` on a checkbox. A dictionary's ids are keys, not names, so
 * they are left exactly as they are.
 */
function getFieldLabel(fieldId: string): string {
  const fields = (activeModel.value?.fields ?? {}) as Record<string, FieldDef>
  return fieldLabel(fieldId, fields[fieldId], {
    locale: currentLocale.value,
    humanize: activeModel.value?.kind !== 'dictionary',
  })
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
provide(getFieldLabelKey, getFieldLabel)
provide(activeModelMetaKey, activeModelMeta)
provide(getModelFieldsKey, getModelFields)
provide(relationLabelsKey, relationLabels)
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
        <template v-if="panelState === 'branch'">
          {{ branchReview?.info.modelName ?? t('review.title') }}
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
        <!-- Title field. Not behind the forms gate: which field titles an entry
             is part of the model contract, not a forms feature. -->
        <PopoverRoot v-if="editable && activeModel && activeModel.kind !== 'dictionary'" v-model:open="titleFieldOpen">
          <PopoverTrigger as-child>
            <AtomsIconButton
              icon="icon-[annon--text]"
              :label="t('content.title_field')"
              size="sm"
            />
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              side="bottom"
              align="end"
              :side-offset="6"
              :collision-padding="8"
              class="z-50 w-64 rounded-lg border border-secondary-200 bg-white p-3 shadow-lg dark:border-secondary-700 dark:bg-secondary-900"
            >
              <p class="text-xs font-medium text-heading dark:text-secondary-100">
                {{ t('content.title_field') }}
              </p>
              <p class="mt-0.5 text-[11px] leading-relaxed text-muted">
                {{ t('content.title_field_description') }}
              </p>

              <p v-if="titleFieldChoices.length === 0" class="mt-2 text-[11px] text-muted">
                {{ t('content.title_field_none') }}
              </p>
              <div v-else class="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
                <button
                  v-for="field in titleFieldChoices"
                  :key="field"
                  type="button"
                  :disabled="titleFieldSaving"
                  :aria-pressed="field === currentTitleField"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800"
                  :class="field === currentTitleField ? 'text-heading dark:text-secondary-100' : 'text-body dark:text-secondary-300'"
                  @click="setTitleField(field)"
                >
                  <span
                    class="size-3.5 shrink-0"
                    :class="field === currentTitleField ? 'icon-[annon--check-circle] text-primary-500' : 'icon-[annon--radio] text-disabled'"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 truncate font-mono">{{ field }}</span>
                </button>
              </div>

              <p v-if="titleFieldError" class="mt-2 text-[11px] text-danger-500">
                {{ titleFieldError }}
              </p>
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
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
        <div v-if="branchReviewLoading" class="space-y-3 p-5">
          <AtomsSkeleton v-for="i in 4" :key="i" variant="custom" class="h-12 w-full rounded-lg" />
        </div>
        <OrganismsBranchReviewView
          v-else-if="branchReview"
          :review="(branchReview as BranchReview)"
          :raw="(branchRaw as BranchRawDiff | null)"
          :raw-loading="branchRawLoading"
          @merge="emit('branchMerge')"
          @reject="emit('branchReject')"
          @load-raw="emit('branchLoadRaw')"
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
        <OrganismsDeployHookPanel
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
          v-if="isCollection || supportsComments"
          v-model="modelSubTab"
          :tabs="[
            { value: 'content', label: t('forms.tab_content') },
            ...(isFormEnabled ? [{ value: 'submissions' as const, label: t('forms.tab_submissions') }] : []),
            ...(isCollection ? [{ value: 'form' as const, label: t('forms.tab_form_settings') }] : []),
            ...(isCommentsEnabled ? [{ value: 'comments' as const, label: t('comments.tab_comments') }] : []),
            ...(supportsComments ? [{ value: 'comment-settings' as const, label: t('comments.tab_settings') }] : []),
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

        <!-- Comments moderation tab -->
        <OrganismsCommentModerationView
          v-else-if="isCommentsEnabled && modelSubTab === 'comments' && workspaceId && projectId && activeModelId"
          :workspace-id="workspaceId"
          :project-id="projectId"
          :model-id="activeModelId"
          :editable="editable"
        />

        <!-- Comment settings tab -->
        <OrganismsCommentsConfigSection
          v-else-if="modelSubTab === 'comment-settings' && workspaceId && projectId && activeModelId"
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
              :meta="modelContentMeta"
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
