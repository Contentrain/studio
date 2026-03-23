<script setup lang="ts">
import { ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxRoot, ComboboxViewport, DialogContent, DialogOverlay, DialogPortal, DialogRoot } from 'radix-vue'

const { t } = useContent()
const { models } = useSnapshot()
const router = useRouter()
const route = useRoute()
const { activeWorkspace } = useWorkspaces()
const { projects } = useProjects()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  sendPrompt: [text: string]
}>()

interface CommandItem {
  id: string
  label: string
  sublabel?: string
  icon: string
  group: string
  action: () => void
}

const commands = computed<CommandItem[]>(() => {
  const items: CommandItem[] = []
  const projectId = route.params.projectId as string | undefined
  const isInProject = !!projectId

  // Models (when inside project)
  if (isInProject) {
    for (const model of models.value) {
      items.push({
        id: `model:${model.id}`,
        label: model.name,
        sublabel: model.kind ?? model.type,
        icon: getModelKindIcon(model.kind ?? model.type),
        group: 'Models',
        action: () => {
          router.replace({ query: { model: model.id } })
          open.value = false
        },
      })
    }

    // Quick actions
    items.push({
      id: 'action:vocabulary',
      label: t('content.vocabulary'),
      icon: 'icon-[annon--book-library]',
      group: 'Actions',
      action: () => {
        router.replace({ query: { vocabulary: 'true' } })
        open.value = false
      },
    })

    items.push({
      id: 'action:new-model',
      label: t('content.add_model'),
      icon: 'icon-[annon--plus-circle]',
      group: 'Actions',
      action: () => {
        emit('sendPrompt', 'Create a new content model. Ask me what kind of content I want to manage.')
        open.value = false
      },
    })
  }

  // Projects (always available)
  for (const project of projects.value) {
    items.push({
      id: `project:${project.id}`,
      label: project.repo_full_name,
      icon: 'icon-[annon--folder]',
      group: 'Projects',
      action: () => {
        if (activeWorkspace.value) {
          router.push(`/w/${activeWorkspace.value.slug}/projects/${project.id}`)
        }
        open.value = false
      },
    })
  }

  // Navigation
  items.push({
    id: 'nav:settings',
    label: t('common.settings'),
    icon: 'icon-[annon--gear]',
    group: 'Navigation',
    action: () => {
      if (activeWorkspace.value) {
        router.push(`/w/${activeWorkspace.value.slug}/settings`)
      }
      open.value = false
    },
  })

  return items
})

function filterCommands(options: readonly string[], term: string): string[] {
  if (!term) return [...options]
  const q = term.toLowerCase()
  return options.filter((id) => {
    const cmd = commands.value.find(c => c.id === id)
    return cmd?.label.toLowerCase().includes(q) || cmd?.sublabel?.toLowerCase().includes(q)
  })
}

function handleSelect(id: string) {
  const cmd = commands.value.find(c => c.id === id)
  cmd?.action()
}

// Global ⌘K shortcut
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    open.value = !open.value
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out" />
      <DialogContent class="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-secondary-200 bg-white shadow-2xl dark:border-secondary-800 dark:bg-secondary-950">
        <ComboboxRoot
          :filter-function="filterCommands"
          @update:model-value="handleSelect($event as unknown as string)"
        >
          <ComboboxAnchor class="flex items-center gap-2 border-b border-secondary-200 px-4 dark:border-secondary-800">
            <span class="icon-[annon--search] size-4 shrink-0 text-muted" aria-hidden="true" />
            <ComboboxInput
              :placeholder="t('common.search')"
              class="h-12 flex-1 bg-transparent text-sm text-heading placeholder:text-muted focus:outline-none dark:text-secondary-100"
              autofocus
            />
            <kbd class="rounded border border-secondary-200 bg-secondary-50 px-1.5 py-0.5 text-[10px] font-medium text-muted dark:border-secondary-700 dark:bg-secondary-800">
              ESC
            </kbd>
          </ComboboxAnchor>

          <ComboboxContent class="max-h-80 overflow-y-auto p-2" :dismiss-on-select="false">
            <ComboboxViewport>
              <ComboboxEmpty class="px-3 py-6 text-center text-sm text-muted">
                No results found
              </ComboboxEmpty>
              <ComboboxItem
                v-for="cmd in commands"
                :key="cmd.id"
                :value="cmd.id"
                class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none transition-colors data-highlighted:bg-secondary-50 dark:data-highlighted:bg-secondary-900"
              >
                <span :class="cmd.icon" class="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span class="flex-1 text-heading dark:text-secondary-100">{{ cmd.label }}</span>
                <span v-if="cmd.sublabel" class="text-xs text-muted">{{ cmd.sublabel }}</span>
              </ComboboxItem>
            </ComboboxViewport>
          </ComboboxContent>
        </ComboboxRoot>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
