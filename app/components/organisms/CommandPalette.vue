<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot } from 'radix-vue'
import type { ResultItem } from '~/composables/useCommandPalette'

const { t } = useContent()
const { models, snapshot } = useSnapshot()
const { branches } = useBranches()
const { conversations, clearChat, selectedModel } = useChat()
const { activeWorkspace, workspaces } = useWorkspaces()
const { projects } = useProjects()
const { isDark, toggle: toggleTheme } = useTheme()
const { signOut } = useAuth()
const router = useRouter()
const route = useRoute()
const { open, addRecent, parseInput, buildResults, groupResults, emitAction } = useCommandPalette()

const searchInput = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const selectedIndex = ref(0)

// Focus input when opened
watch(open, (isOpen) => {
  if (isOpen) {
    searchInput.value = ''
    nextTick(() => inputRef.value?.focus())
  }
})

// Global ⌘K shortcut
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    open.value = !open.value
  }
  if (e.key === 'Escape' && open.value) {
    open.value = false
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// Parse current search
const parsed = computed(() => parseInput(searchInput.value))

// Placeholder
const placeholder = computed(() => {
  switch (parsed.value.mode) {
    case 'command': return 'Type a command...'
    case 'vocab': return 'Search vocabulary terms...'
    case 'branch': return 'Search branches...'
    case 'model': return `Search in @${parsed.value.modelId}...`
    case 'help': return 'Search help topics...'
    default: return 'Search or type > for commands...'
  }
})

// Mode badge
const modeBadge = computed((): { label: string, color: 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info' } | null => {
  switch (parsed.value.mode) {
    case 'command': return { label: 'Commands', color: 'info' }
    case 'vocab': return { label: 'Vocabulary', color: 'success' }
    case 'branch': return { label: 'Branches', color: 'warning' }
    case 'model': return { label: `@${parsed.value.modelId}`, color: 'primary' }
    case 'help': return { label: 'Help', color: 'secondary' }
    default: return null
  }
})

const isInProject = computed(() => !!route.params.projectId)

// Build results via composable
const results = computed<ResultItem[]>(() => {
  const { mode, query, modelId } = parsed.value
  return buildResults({
    mode,
    query,
    modelId,
    isInProject: isInProject.value,
    isDark: isDark.value,
    currentModelId: selectedModel.value,
    t,
    models: models.value,
    branches: branches.value,
    conversations: conversations.value,
    projects: projects.value,
    workspaces: workspaces.value as Array<{ id: string, name: string, slug: string, plan: string }>,
    snapshot: snapshot.value as { vocabulary?: Record<string, Record<string, string>>, content?: Record<string, { count: number }> } | null,
    onAction: handleAction,
    onRecent: executeRecent,
    onLoadConversation: loadConversation,
    onNavigateModel: navigateToModel,
    onNavigateBranch: navigateToBranch,
    onNavigateProject: navigateToProject,
    onNavigateWorkspace: navigateToWorkspace,
  })
})

const groupedResults = computed(() => groupResults(results.value))
const hasResults = computed(() => results.value.length > 0)

watch(results, () => {
  selectedIndex.value = 0
})

// ── Action resolver ────────────────────────────────────────

function handleAction(actionKey: string, payload?: Record<string, unknown>) {
  const slug = activeWorkspace.value?.slug

  switch (actionKey) {
    // Appearance
    case 'toggle-theme':
      toggleTheme()
      break

    // Global navigation
    case 'sign-out':
      signOut()
      break
    case 'switch-workspace':
      router.push('/')
      break
    case 'create-workspace':
      router.push('/')
      break

    // Workspace settings
    case 'ws-settings':
      if (slug) router.push(`/w/${slug}/settings`)
      break
    case 'ws-members':
      if (slug) router.push(`/w/${slug}/settings?tab=members`)
      break
    case 'ws-github':
      if (slug) router.push(`/w/${slug}/settings?tab=github`)
      break
    case 'ws-ai-keys':
      if (slug) router.push(`/w/${slug}/settings?tab=ai-keys`)
      break
    case 'connect-repo':
      emitAction({ type: 'connect-repo' })
      break

    // Project navigation
    case 'project-overview':
      router.replace({ query: {} })
      break
    case 'new-conversation':
      clearChat()
      break
    case 'open-vocabulary':
      router.replace({ query: { vocabulary: 'true' } })
      break
    case 'open-cdn':
      router.replace({ query: { cdn: 'true' } })
      break
    case 'open-media':
      router.replace({ query: { assets: 'true' } })
      break
    case 'open-health':
      router.replace({ query: { health: 'true' } })
      break
    case 'open-project-settings':
      emitAction({ type: 'open-project-settings' })
      break
    case 'open-webhooks':
      emitAction({ type: 'open-project-settings', payload: 'webhooks' })
      break
    case 'open-conversation-keys':
      emitAction({ type: 'open-project-settings', payload: 'api' })
      break

    // AI model
    case 'set-model-haiku':
      selectedModel.value = 'claude-haiku-4-5-20251001'
      break
    case 'set-model-sonnet':
      selectedModel.value = 'claude-sonnet-4-20250514'
      break
    case 'set-model-opus':
      selectedModel.value = 'claude-opus-4-20250514'
      break

    // Agent prompts
    case 'send-prompt':
      if (payload?.prompt) {
        emitAction({ type: 'send-prompt', payload: payload.prompt as string })
      }
      break
  }

  open.value = false
}

// ── Navigation helpers ─────────────────────────────────────

function navigateToModel(modelId: string, modelName: string) {
  addRecent({ id: `model:${modelId}`, label: modelName, sublabel: 'model', icon: 'icon-[annon--layers]', type: 'model' })
  router.replace({ query: { model: modelId } })
  open.value = false
}

function navigateToBranch(branchName: string) {
  addRecent({ id: `branch:${branchName}`, label: branchName.replace('contentrain/', ''), icon: 'icon-[annon--arrow-swap]', type: 'branch' })
  router.replace({ query: { branch: encodeURIComponent(branchName) } })
  open.value = false
}

function navigateToProject(projectId: string) {
  if (activeWorkspace.value) {
    router.push(`/w/${activeWorkspace.value.slug}/projects/${projectId}`)
  }
  open.value = false
}

function navigateToWorkspace(workspaceId: string, slug: string) {
  const { setActiveWorkspace } = useWorkspaces()
  setActiveWorkspace(workspaceId)
  router.push(`/w/${slug}`)
  open.value = false
}

async function loadConversation(convId: string) {
  const ws = activeWorkspace.value
  const projectId = route.params.projectId as string | undefined
  if (ws && projectId) {
    const { loadConversation: load } = useChat()
    await load(ws.id, projectId, convId)
  }
  open.value = false
}

function executeRecent(item: { id: string, type: string }) {
  if (item.id.startsWith('model:')) {
    const modelId = item.id.replace('model:', '')
    router.replace({ query: { model: modelId } })
  }
  else if (item.id.startsWith('branch:')) {
    const branchName = item.id.replace('branch:', '')
    router.replace({ query: { branch: encodeURIComponent(branchName) } })
  }
  else if (item.id.startsWith('project:')) {
    const projectId = item.id.replace('project:', '')
    navigateToProject(projectId)
    return
  }
  else if (item.id.startsWith('ws:')) {
    const wsId = item.id.replace('ws:', '')
    const ws = workspaces.value.find(w => w.id === wsId)
    if (ws) navigateToWorkspace(ws.id, ws.slug)
    return
  }
  open.value = false
}

function executeItem(item: ResultItem) {
  addRecent({ id: item.id, label: item.label, sublabel: item.sublabel, icon: item.icon, type: item.type })
  item.action()
}

// Keyboard navigation
function handleKeyNav(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, results.value.length - 1)
  }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  }
  else if (e.key === 'Enter') {
    e.preventDefault()
    const item = results.value[selectedIndex.value]
    if (item) executeItem(item)
  }
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out" />
      <DialogContent
        class="fixed left-1/2 top-[15%] z-50 flex w-full max-w-lg -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-secondary-200 bg-white shadow-2xl dark:border-secondary-800 dark:bg-secondary-950"
        @keydown="handleKeyNav"
      >
        <!-- Search input -->
        <div class="flex items-center gap-2 border-b border-secondary-200 px-4 dark:border-secondary-800">
          <span class="icon-[annon--search] size-4 shrink-0 text-muted" aria-hidden="true" />
          <AtomsBadge v-if="modeBadge" :variant="modeBadge.color" size="sm" class="shrink-0">
            {{ modeBadge.label }}
          </AtomsBadge>
          <input
            ref="inputRef"
            v-model="searchInput"
            :placeholder="placeholder"
            class="h-12 flex-1 bg-transparent text-sm text-heading placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-secondary-100"
          >
          <kbd class="shrink-0 rounded border border-secondary-200 bg-secondary-50 px-1.5 py-0.5 text-[10px] font-medium text-muted dark:border-secondary-700 dark:bg-secondary-800">
            ESC
          </kbd>
        </div>

        <!-- Results -->
        <div class="max-h-80 overflow-y-auto">
          <!-- No results -->
          <div v-if="!hasResults && searchInput.length > 0" class="flex flex-col items-center gap-2 px-4 py-8">
            <span class="icon-[annon--search] size-5 text-disabled" aria-hidden="true" />
            <span class="text-sm text-muted">{{ t('common.no_results') }}</span>
          </div>

          <!-- Empty state (no query) -->
          <div v-else-if="!hasResults" class="px-4 py-6 text-center text-xs text-muted">
            <p>Type to search · <span class="font-medium">></span> commands · <span class="font-medium">#</span> vocabulary · <span class="font-medium">!</span> branches · <span class="font-medium">?</span> help</p>
          </div>

          <!-- Grouped results -->
          <template v-for="(groupItems, groupName) in groupedResults" :key="groupName">
            <div class="px-3 pt-2 pb-1">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-muted">{{ groupName }}</span>
            </div>
            <div class="px-2 pb-1">
              <button
                v-for="item in groupItems"
                :key="item.id"
                type="button"
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :class="results.indexOf(item) === selectedIndex
                  ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/20 dark:text-primary-300'
                  : 'text-heading hover:bg-secondary-50 dark:text-secondary-100 dark:hover:bg-secondary-900'
                "
                @click="executeItem(item)"
                @mouseenter="selectedIndex = results.indexOf(item)"
              >
                <span :class="item.icon" class="size-4 shrink-0 opacity-60" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                <span v-if="item.sublabel" class="shrink-0 truncate text-xs text-muted">{{ item.sublabel }}</span>
              </button>
            </div>
          </template>
        </div>

        <!-- Footer hints -->
        <div class="flex items-center gap-3 border-t border-secondary-100 px-4 py-2 text-[10px] text-disabled dark:border-secondary-800">
          <span>↑↓ navigate</span>
          <span>↩ select</span>
          <span>esc close</span>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
