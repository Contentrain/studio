<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot } from 'radix-vue'

const { t } = useContent()
const { models, snapshot } = useSnapshot()
const { branches } = useBranches()
const { conversations } = useChat()
const { activeWorkspace } = useWorkspaces()
const { projects } = useProjects()
const { isDark, toggle: toggleTheme } = useTheme()
const router = useRouter()
const route = useRoute()
const { open, addRecent, parseInput, matches } = useCommandPalette()
const { clearChat } = useChat()

const searchInput = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

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

// Placeholder text based on mode
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
const modeBadge = computed(() => {
  switch (parsed.value.mode) {
    case 'command': return { label: 'Commands', color: 'info' }
    case 'vocab': return { label: 'Vocabulary', color: 'success' }
    case 'branch': return { label: 'Branches', color: 'warning' }
    case 'model': return { label: `@${parsed.value.modelId}`, color: 'primary' }
    case 'help': return { label: 'Help', color: 'secondary' }
    default: return null
  }
})

// Build results
interface ResultItem {
  id: string
  label: string
  sublabel?: string
  icon: string
  group: string
  type: string
  keywords?: string[]
  action: () => void
}

const results = computed<ResultItem[]>(() => {
  const { mode, query, modelId } = parsed.value
  const items: ResultItem[] = []
  const isInProject = !!route.params.projectId

  // RECENT (only when no query)
  if (mode === 'global' && !query) {
    const recent = useCommandPalette().getRecent()
    for (const r of recent) {
      items.push({
        id: `recent:${r.id}`,
        label: r.label,
        sublabel: r.sublabel,
        icon: r.icon,
        group: 'Recent',
        type: 'recent',
        action: () => executeRecent(r),
      })
    }
  }

  // COMMANDS MODE
  if (mode === 'command' || (mode === 'global' && query.length > 0)) {
    const commands = getStaticCommands(isInProject)
    for (const cmd of commands) {
      if (mode === 'command' || query.length >= 2) {
        if (matches(cmd.label, query) || cmd.keywords?.some((k: string) => matches(k, query))) {
          items.push({ ...cmd, group: 'Commands' })
        }
      }
    }
  }

  // MODELS
  if ((mode === 'global') && isInProject) {
    for (const model of models.value) {
      if (matches(model.name, query) || matches(model.id, query) || matches(model.domain ?? '', query)) {
        items.push({
          id: `model:${model.id}`,
          label: model.name,
          sublabel: `${model.kind} · ${(model as { domain?: string }).domain ?? ''}`,
          icon: getModelKindIcon(model.kind ?? model.type),
          group: 'Models',
          type: 'model',
          action: () => navigateToModel(model.id, model.name),
        })
      }
    }
  }

  // VOCABULARY
  if ((mode === 'vocab' || mode === 'global') && isInProject) {
    const vocab = snapshot.value?.vocabulary as Record<string, Record<string, string>> | null
    if (vocab) {
      for (const [term, translations] of Object.entries(vocab)) {
        const value = translations.en ?? Object.values(translations)[0] ?? ''
        if (matches(term, query) || matches(value, query)) {
          items.push({
            id: `vocab:${term}`,
            label: term,
            sublabel: value,
            icon: 'icon-[annon--book-library]',
            group: 'Vocabulary',
            type: 'vocab',
            action: () => navigateToVocabulary(),
          })
        }
        if (items.filter(i => i.group === 'Vocabulary').length >= 5) break
      }
    }
  }

  // BRANCHES
  if ((mode === 'branch' || mode === 'global') && isInProject) {
    for (const branch of branches.value) {
      if (matches(branch.name, query)) {
        items.push({
          id: `branch:${branch.name}`,
          label: branch.name.replace('contentrain/', ''),
          sublabel: branch.sha.substring(0, 7),
          icon: 'icon-[annon--arrow-swap]',
          group: 'Branches',
          type: 'branch',
          action: () => navigateToBranch(branch.name),
        })
      }
    }
  }

  // CONVERSATIONS
  if (mode === 'global' && isInProject && query.length >= 2) {
    for (const conv of conversations.value) {
      if (matches(conv.title ?? '', query)) {
        items.push({
          id: `conv:${conv.id}`,
          label: conv.title || t('chat.untitled'),
          sublabel: new Date(conv.updated_at).toLocaleDateString(),
          icon: 'icon-[annon--comment-2]',
          group: 'Conversations',
          type: 'conversation',
          action: () => loadConversation(conv.id),
        })
      }
      if (items.filter(i => i.group === 'Conversations').length >= 3) break
    }
  }

  // PROJECTS
  if (mode === 'global') {
    for (const project of projects.value) {
      if (matches(project.repo_full_name, query)) {
        items.push({
          id: `project:${project.id}`,
          label: project.repo_full_name.split('/').pop() ?? project.repo_full_name,
          sublabel: project.detected_stack ?? '',
          icon: 'icon-[annon--folder]',
          group: 'Projects',
          type: 'project',
          action: () => navigateToProject(project.id),
        })
      }
    }
  }

  // MODEL ENTRIES (@model search)
  if (mode === 'model' && modelId && isInProject) {
    // Get content from snapshot if available
    const content = snapshot.value?.content as Record<string, { count: number }> | undefined
    if (content?.[modelId]) {
      items.push({
        id: `model-nav:${modelId}`,
        label: `Open ${modelId}`,
        sublabel: `${content[modelId].count} entries`,
        icon: 'icon-[annon--arrow-right]',
        group: `@${modelId}`,
        type: 'command',
        action: () => navigateToModel(modelId, modelId),
      })
    }
  }

  // HELP
  if (mode === 'help') {
    const helps = [
      { id: 'help:search', label: 'Global search', sublabel: 'Type anything to search models, entries, vocabulary', icon: 'icon-[annon--search]' },
      { id: 'help:commands', label: '> Commands', sublabel: 'Type > to see available actions', icon: 'icon-[annon--code]' },
      { id: 'help:vocab', label: '# Vocabulary', sublabel: 'Type # to search vocabulary terms', icon: 'icon-[annon--book-library]' },
      { id: 'help:branch', label: '! Branches', sublabel: 'Type ! to search content branches', icon: 'icon-[annon--arrow-swap]' },
      { id: 'help:model', label: '@model Search', sublabel: 'Type @modelId to search within a model', icon: 'icon-[annon--layers]' },
      { id: 'help:shortcut', label: '⌘K', sublabel: 'Open this palette from anywhere', icon: 'icon-[annon--key]' },
    ]
    for (const h of helps) {
      if (matches(h.label, query) || matches(h.sublabel, query)) {
        items.push({ ...h, group: 'Help', type: 'help', action: () => {} })
      }
    }
  }

  return items
})

// Group results
const groupedResults = computed(() => {
  const groups: Record<string, ResultItem[]> = {}
  for (const item of results.value) {
    if (!groups[item.group]) groups[item.group] = []
    groups[item.group]!.push(item)
  }
  return groups
})

const hasResults = computed(() => results.value.length > 0)

// Static commands
function getStaticCommands(isInProject: boolean): ResultItem[] {
  const cmds: ResultItem[] = []

  // Always available
  cmds.push({
    id: 'cmd:dark-mode',
    label: isDark.value ? t('common.light_mode') : t('common.dark_mode'),
    icon: isDark.value ? 'icon-[annon--sun]' : 'icon-[annon--moon]',
    group: 'Commands',
    type: 'command',
    keywords: ['theme', 'dark', 'light', 'mode'],
    action: () => {
      toggleTheme()
      open.value = false
    },
  })

  cmds.push({
    id: 'cmd:settings',
    label: t('common.settings'),
    icon: 'icon-[annon--gear]',
    group: 'Commands',
    type: 'command',
    keywords: ['settings', 'workspace', 'members'],
    action: () => navigateToSettings(),
  })

  if (isInProject) {
    cmds.push({
      id: 'cmd:new-conversation',
      label: t('chat.new_conversation'),
      icon: 'icon-[annon--plus-circle]',
      group: 'Commands',
      type: 'command',
      keywords: ['chat', 'new', 'conversation', 'clear'],
      action: () => {
        clearChat()
        open.value = false
      },
    })

    cmds.push({
      id: 'cmd:vocabulary',
      label: t('content.vocabulary'),
      icon: 'icon-[annon--book-library]',
      group: 'Commands',
      type: 'command',
      keywords: ['vocabulary', 'terms', 'glossary'],
      action: () => navigateToVocabulary(),
    })

    cmds.push({
      id: 'cmd:cdn',
      label: t('cdn.title'),
      icon: 'icon-[annon--globe]',
      group: 'Commands',
      type: 'command',
      keywords: ['cdn', 'delivery', 'api', 'build'],
      action: () => {
        router.replace({ query: { cdn: 'true' } })
        open.value = false
      },
    })

    cmds.push({
      id: 'cmd:add-model',
      label: t('content.add_model'),
      icon: 'icon-[annon--plus]',
      group: 'Commands',
      type: 'command',
      keywords: ['create', 'model', 'new', 'schema'],
      action: () => {
        emit('sendPrompt', 'Create a new content model. Ask me what kind of content I want to manage.')
        open.value = false
      },
    })

    cmds.push({
      id: 'cmd:add-entry',
      label: t('content.add_entry'),
      icon: 'icon-[annon--file-text]',
      group: 'Commands',
      type: 'command',
      keywords: ['create', 'entry', 'new', 'content', 'add'],
      action: () => {
        emit('sendPrompt', 'Create a new entry. Ask me which model and what content.')
        open.value = false
      },
    })

    cmds.push({
      id: 'cmd:translate',
      label: 'Translate content',
      icon: 'icon-[annon--globe]',
      group: 'Commands',
      type: 'command',
      keywords: ['translate', 'locale', 'language', 'i18n'],
      action: () => {
        emit('sendPrompt', 'Translate content to another locale. Ask me which model and target language.')
        open.value = false
      },
    })
  }

  return cmds
}

// Navigation actions
function navigateToModel(modelId: string, modelName: string) {
  addRecent({ id: `model:${modelId}`, label: modelName, sublabel: 'model', icon: getModelKindIcon('collection'), type: 'model' })
  router.replace({ query: { model: modelId } })
  open.value = false
}

function navigateToVocabulary() {
  router.replace({ query: { vocabulary: 'true' } })
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

function navigateToSettings() {
  if (activeWorkspace.value) {
    router.push(`/w/${activeWorkspace.value.slug}/settings`)
  }
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
  open.value = false
}

function executeItem(item: ResultItem) {
  addRecent({ id: item.id, label: item.label, sublabel: item.sublabel, icon: item.icon, type: item.type })
  item.action()
}

// Keyboard navigation
const selectedIndex = ref(0)
watch(results, () => {
  selectedIndex.value = 0
})

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

const emit = defineEmits<{
  sendPrompt: [text: string]
}>()
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
          <AtomsBadge v-if="modeBadge" :variant="(modeBadge.color as any)" size="sm" class="shrink-0">
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
