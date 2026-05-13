<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)
const projectId = computed(() => route.params.projectId as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace, saveLastPath } = useWorkspaces()
const { projects, fetchProjects } = useProjects()
const { snapshot, loading: snapshotLoading, fetchSnapshot, clearSnapshot, hasContentrain } = useSnapshot()
const { content: modelContent, kind: modelContentKind, meta: modelContentMeta, loading: modelContentLoading, fetchContent, clearContent } = useModelContent()
const { branchDiff, diffLoading, fetchBranchDiff, clearBranchDiff, clearBranches, fetchBranches, mergeBranch, rejectBranch } = useBranches()
const { t } = useContent()

const project = computed(() =>
  projects.value.find(p => p.id === projectId.value) ?? null,
)

// Derive real project status: if snapshot shows .contentrain/ exists, project is active regardless of DB status
// Returns undefined while loading (before project data is available)
const effectiveProjectStatus = computed(() => {
  if (hasContentrain.value) return 'active'
  if (!project.value) return undefined
  return project.value.status ?? 'setup'
})

const activeModelId = computed(() => route.query.model as string ?? null)
const activeBranch = computed(() => {
  const b = (route.query as Record<string, string | undefined>).branch
  return b ? decodeURIComponent(b) : null
})
const activeVocabulary = computed(() => (route.query as Record<string, string | undefined>).vocabulary === 'true')
const activeCDN = computed(() => (route.query as Record<string, string | undefined>).cdn === 'true')
const activeAssets = computed(() => (route.query as Record<string, string | undefined>).assets === 'true')
const activeHealth = computed(() => (route.query as Record<string, string | undefined>).health === 'true')
const activeLocale = ref('en')

// Persist current path — only after confirming project/workspace exist
watch(() => route.fullPath, (path) => {
  if (project.value && activeWorkspace.value) saveLastPath(path)
})

// Bootstrap project state — handles both initial load AND SPA navigation between projects/workspaces.
// Replaces onMounted to ensure state resets on route reuse.
watch([projectId, slug], async ([newProjectId, newSlug], old) => {
  const [oldProjectId, oldSlug] = old ?? [undefined, undefined]

  // Clear stale state from previous project
  if (oldProjectId) {
    clearContent()
    clearBranches()
    clearSnapshot()
  }

  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === newSlug)
  if (!ws) {
    saveLastPath('/')
    await router.replace('/')
    return
  }

  setActiveWorkspace(ws.id)

  // Re-fetch projects on workspace change or when list is empty
  if (!oldSlug || oldSlug !== newSlug || projects.value.length === 0)
    await fetchProjects(ws.id)

  // Verify project exists in this workspace
  const projectExists = projects.value.some(p => p.id === newProjectId)
  if (!projectExists) {
    saveLastPath(`/w/${newSlug}`)
    await router.replace(`/w/${newSlug}`)
    return
  }

  await fetchSnapshot(ws.id, newProjectId)

  // Set default locale from config
  const config = snapshot.value?.config as { locales?: { default?: string } } | null
  activeLocale.value = config?.locales?.default ?? 'en'

  if (activeBranch.value) {
    await fetchBranchDiff(ws.id, newProjectId, activeBranch.value)
  }

  if (activeModelId.value) {
    await fetchContent(ws.id, newProjectId, activeModelId.value, activeLocale.value)
  }
}, { immediate: true })

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

// Consume send-prompt actions from CommandPalette
const { pendingAction: cmdAction, consumeAction: cmdConsume } = useCommandPalette()
watch(cmdAction, (action) => {
  if (action?.type === 'send-prompt' && action.payload) {
    cmdConsume()
    chatPanelRef.value?.handleSend(action.payload)
  }
})

function selectModel(modelId: string) {
  if (modelId === '__health__') {
    router.replace({ query: { health: 'true' } })
    return
  }
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
  panelState: (activeBranch.value ? 'branch' : activeVocabulary.value ? 'vocabulary' : activeCDN.value ? 'overview' : activeModelId.value ? 'model' : 'overview') as 'overview' | 'model' | 'branch' | 'vocabulary',
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
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return

  // Brain invalidation + re-sync (single source of truth)
  if (affected.snapshotChanged || affected.models.length > 0) {
    const { invalidateCache } = useSnapshot()
    await invalidateCache(projectId.value)
    await fetchSnapshot(ws.id, projectId.value)
  }

  if (affected.models.length > 0) {
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

// Mobile tab switching (Chat vs Content) — only affects <lg viewports
const mobileTab = ref<'chat' | 'content'>('chat')
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
  <div class="flex h-full flex-col">
    <!-- Repo access banner: rendered above the panels when GitHub revoked
         access to this project's repo (manual unselect in App settings,
         org admin action, or repo deletion). Without this, every chat
         action would 404 with a generic error. -->
    <div
      v-if="project && project.access_status && project.access_status !== 'accessible'"
      class="flex shrink-0 items-start gap-3 border-b px-6 py-3"
      :class="project.access_status === 'deleted'
        ? 'border-danger-200 bg-danger-50 dark:border-danger-500/20 dark:bg-danger-500/10'
        : 'border-warning-200 bg-warning-50 dark:border-warning-500/20 dark:bg-warning-500/10'"
    >
      <span
        class="size-5 shrink-0"
        :class="project.access_status === 'deleted'
          ? 'icon-[annon--alert-triangle] text-danger-500'
          : 'icon-[annon--alert-circle] text-warning-500'"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <p
          class="text-sm font-medium"
          :class="project.access_status === 'deleted'
            ? 'text-danger-700 dark:text-danger-400'
            : 'text-warning-700 dark:text-warning-400'"
        >
          {{ project.access_status === 'deleted' ? t('github.repo_deleted_title') : t('github.repo_access_revoked_title') }}
        </p>
        <p
          class="mt-0.5 text-xs"
          :class="project.access_status === 'deleted'
            ? 'text-danger-600 dark:text-danger-400/80'
            : 'text-warning-700 dark:text-warning-400/80'"
        >
          {{ project.access_status === 'deleted' ? t('github.repo_deleted_hint') : t('github.repo_access_revoked_hint') }}
        </p>
      </div>
      <a
        v-if="activeWorkspace?.github_installation_id && project.access_status !== 'deleted'"
        :href="`https://github.com/settings/installations/${activeWorkspace.github_installation_id}`"
        target="_blank"
        rel="noopener noreferrer"
        class="shrink-0 rounded-md border border-warning-300 bg-white px-3 py-1.5 text-xs font-medium text-warning-700 transition-colors hover:bg-warning-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning-500/50 dark:border-warning-500/40 dark:bg-secondary-900 dark:text-warning-400 dark:hover:bg-secondary-800"
      >
        {{ t('github.manage_app_settings_button') }}
      </a>
    </div>

    <div class="flex min-h-0 flex-1">
      <!-- Chat panel: always visible on lg+, on mobile only when chat tab active -->
      <div
        class="min-w-0 flex-1 flex-col"
        :class="mobileTab === 'chat' ? 'flex' : 'hidden lg:flex'"
      >
        <OrganismsChatPanel
          v-if="activeWorkspace"
          ref="chatPanelRef"
          :workspace-id="activeWorkspace.id"
          :project-id="projectId"
          :project-name="project?.repo_full_name?.split('/').pop() ?? t('common.loading')"
          :project-status="effectiveProjectStatus"
          :context="chatContext"
          @content-changed="handleContentChanged"
        />
      </div>

      <!-- Content panel: always visible on lg+, on mobile only when content tab active -->
      <div
        class="min-w-0 shrink-0 flex-col border-l border-secondary-200 dark:border-secondary-800"
        :class="mobileTab === 'content' ? 'flex flex-1 lg:w-80 lg:flex-initial xl:w-96' : 'hidden lg:flex lg:w-80 xl:w-96'"
      >
        <OrganismsContentPanel
          v-model:locale="activeLocale"
          :snapshot="snapshot"
          :snapshot-loading="snapshotLoading"
          :model-content="modelContent"
          :model-content-kind="modelContentKind"
          :model-content-meta="modelContentMeta"
          :model-content-loading="modelContentLoading"
          :active-model-id="activeModelId"
          :active-branch="activeBranch"
          :active-vocabulary="activeVocabulary"
          :active-cdn="activeCDN"
          :active-assets="activeAssets"
          :active-health="activeHealth"
          :branch-diff="branchDiff"
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

    <!-- Mobile bottom tab bar (only visible below lg) -->
    <nav class="flex shrink-0 border-t border-secondary-200 dark:border-secondary-800 lg:hidden">
      <button
        type="button"
        class="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50"
        :class="mobileTab === 'chat' ? 'bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400' : 'text-muted hover:text-body dark:hover:text-secondary-300'"
        @click="mobileTab = 'chat'"
      >
        <span class="icon-[annon--comment-2] size-5" aria-hidden="true" />
        <span>{{ t('mobile.tab_chat') }}</span>
      </button>
      <button
        type="button"
        class="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50"
        :class="mobileTab === 'content' ? 'bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400' : 'text-muted hover:text-body dark:hover:text-secondary-300'"
        @click="mobileTab = 'content'"
      >
        <span class="icon-[annon--layers] size-5" aria-hidden="true" />
        <span>{{ t('mobile.tab_content') }}</span>
      </button>
    </nav>
  </div>
</template>
