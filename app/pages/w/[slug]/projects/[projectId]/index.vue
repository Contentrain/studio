<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)
const projectId = computed(() => route.params.projectId as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { projects, fetchProjects } = useProjects()
const { snapshot, loading: snapshotLoading, fetchSnapshot, hasContentrain } = useSnapshot()
const { content: modelContent, kind: modelContentKind, meta: modelContentMeta, loading: modelContentLoading, fetchContent, clearContent } = useModelContent()
const { branchDiff, diffLoading, fetchBranchDiff, clearBranchDiff, fetchBranches, mergeBranch, rejectBranch } = useBranches()
const { t } = useContent()

const project = computed(() =>
  projects.value.find(p => p.id === projectId.value) ?? null,
)

// Derive real project status: if snapshot shows .contentrain/ exists, project is active regardless of DB status
const effectiveProjectStatus = computed(() => {
  if (hasContentrain.value) return 'active'
  return project.value?.status ?? 'setup'
})

const activeModelId = computed(() => route.query.model as string ?? null)
const activeBranch = computed(() => {
  const b = (route.query as Record<string, string | undefined>).branch
  return b ? decodeURIComponent(b) : null
})
const activeVocabulary = computed(() => (route.query as Record<string, string | undefined>).vocabulary === 'true')
const activeLocale = ref('en')

onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
    if (projects.value.length === 0)
      await fetchProjects(ws.id)
    await fetchSnapshot(ws.id, projectId.value)

    // Set default locale from config
    const config = snapshot.value?.config as { locales?: { default?: string } } | null
    if (config?.locales?.default) activeLocale.value = config.locales.default

    if (activeModelId.value) {
      await fetchContent(ws.id, projectId.value, activeModelId.value, activeLocale.value)
    }
  }
})

// Watch for model changes AFTER initial load (user clicks in sidebar)
watch(activeModelId, async (modelId, oldModelId) => {
  // Skip initial — handled by onMounted above
  if (oldModelId === undefined) return
  if (!modelId) {
    clearContent()
    return
  }
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return
  await fetchContent(ws.id, projectId.value, modelId, activeLocale.value)
})

// Locale change — re-fetch current model content
watch(activeLocale, async (locale) => {
  if (!activeModelId.value) return
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return
  await fetchContent(ws.id, projectId.value, activeModelId.value, locale)
})

// Branch selection — fetch diff
watch(activeBranch, async (branch, oldBranch) => {
  if (oldBranch === undefined) return
  if (!branch) {
    clearBranchDiff()
    return
  }
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return
  await fetchBranchDiff(ws.id, projectId.value, branch)
})

const chatPanelRef = ref<{ handleSend: (text: string) => void } | null>(null)

function selectModel(modelId: string) {
  router.replace({ query: { ...route.query, model: modelId } })
}

function backToOverview() {
  router.replace({ query: {} })
  clearBranchDiff()
}

// Chat UI context — tells the agent what the user is looking at
const chatContext = computed(() => ({
  activeModelId: activeModelId.value,
  activeLocale: activeLocale.value,
  activeEntryId: null as string | null,
  panelState: (activeBranch.value ? 'branch' : activeVocabulary.value ? 'vocabulary' : activeModelId.value ? 'model' : 'overview') as 'overview' | 'model' | 'branch' | 'vocabulary',
  activeBranch: activeBranch.value,
}))

// Branch merge/reject handlers
async function handleBranchMerge() {
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws || !activeBranch.value) return
  const merged = await mergeBranch(ws.id, projectId.value, activeBranch.value)
  if (merged) {
    // Clear branch query and refresh
    const query = { ...route.query }
    delete query.branch
    router.replace({ query })
    clearBranchDiff()
    await fetchBranches(ws.id, projectId.value)
    // Refresh snapshot + content since merged content changed main
    const { invalidateCache } = useSnapshot()
    await invalidateCache(projectId.value)
    await fetchSnapshot(ws.id, projectId.value)
  }
}

async function handleBranchReject() {
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws || !activeBranch.value) return
  const rejected = await rejectBranch(ws.id, projectId.value, activeBranch.value)
  if (rejected) {
    const query = { ...route.query }
    delete query.branch
    router.replace({ query })
    clearBranchDiff()
    await fetchBranches(ws.id, projectId.value)
  }
}

// Targeted cache invalidation from tool execution results
async function handleContentChanged(affected: { models: string[], locales: string[], snapshotChanged: boolean, branchesChanged?: boolean }) {
  const { invalidateCache } = useSnapshot()
  const { invalidateProjectContent } = useModelContent()
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return

  // Invalidate only what changed
  if (affected.snapshotChanged) {
    await invalidateCache(projectId.value)
    await fetchSnapshot(ws.id, projectId.value)
  }

  if (affected.models.length > 0) {
    await invalidateProjectContent(projectId.value)
    if (activeModelId.value && affected.models.includes(activeModelId.value)) {
      await fetchContent(ws.id, projectId.value, activeModelId.value, activeLocale.value)
    }
  }

  // Refresh branch list when branches change
  if (affected.branchesChanged) {
    await fetchBranches(ws.id, projectId.value)
  }
}

// Vocabulary save handler
const toast = useToast()
async function handleVocabularySave(terms: Record<string, Record<string, string> | null>) {
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return
  try {
    await $fetch(`/api/workspaces/${ws.id}/projects/${projectId.value}/vocabulary`, {
      method: 'PATCH',
      body: { terms },
    })
    // Refresh snapshot to get updated vocabulary
    const { invalidateCache } = useSnapshot()
    await invalidateCache(projectId.value)
    await fetchSnapshot(ws.id, projectId.value)
  }
  catch {
    toast.error('Failed to update vocabulary')
  }
}
</script>

<template>
  <div class="flex h-full">
    <!-- Chat panel -->
    <div class="flex min-w-0 flex-1 flex-col">
      <OrganismsChatPanel
        v-if="activeWorkspace"
        ref="chatPanelRef"
        :workspace-id="activeWorkspace.id"
        :project-id="projectId"
        :project-name="project?.repo_full_name ?? t('common.loading')"
        :project-status="effectiveProjectStatus"
        :context="chatContext"
        @content-changed="handleContentChanged"
      />
    </div>

    <!-- Context panel -->
    <div class="hidden w-80 min-w-0 shrink-0 border-l border-secondary-200 lg:flex lg:flex-col xl:w-96 dark:border-secondary-800">
      <OrganismsContentPanel
        v-model:locale="activeLocale"
        :snapshot="(snapshot as any)"
        :snapshot-loading="snapshotLoading"
        :model-content="modelContent"
        :model-content-kind="modelContentKind"
        :model-content-meta="modelContentMeta"
        :model-content-loading="modelContentLoading"
        :active-model-id="activeModelId"
        :active-branch="activeBranch"
        :active-vocabulary="activeVocabulary"
        :branch-diff="(branchDiff as any)"
        :branch-diff-loading="diffLoading"
        :can-manage-branches="true"
        :workspace-id="activeWorkspace?.id"
        :project-id="projectId"
        editable
        @select-model="selectModel"
        @back="backToOverview"
        @send-chat-prompt="chatPanelRef?.handleSend($event)"
        @branch-merge="handleBranchMerge"
        @branch-reject="handleBranchReject"
        @vocabulary-save="handleVocabularySave"
      />
    </div>
  </div>
</template>
