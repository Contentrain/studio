<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger } from 'radix-vue'

const { t } = useContent()
const { activeWorkspace } = useWorkspaces()
const toast = useToast()

const open = defineModel<boolean>('open', { default: false })

// State machine
type DialogState = 'install' | 'select' | 'confirm'

const state = ref<DialogState>('install')
const repos = ref<Array<{
  id: number
  fullName: string
  name: string
  owner: string
  private: boolean
  defaultBranch: string
  description: string | null
  language: string | null
  updatedAt: string | null
}>>([])
const reposLoading = ref(false)
const searchQuery = ref('')
const selectedRepo = ref<typeof repos.value[0] | null>(null)
const scanResult = ref<{
  defaultBranch: string
  stack: string
  hasContentDir: boolean
  hasI18n: boolean
} | null>(null)
const scanLoading = ref(false)
const connecting = ref(false)

// Determine initial state based on workspace installation
watch(open, async (isOpen) => {
  if (!isOpen) {
    // Reset on close
    state.value = 'install'
    selectedRepo.value = null
    scanResult.value = null
    searchQuery.value = ''
    return
  }

  if (activeWorkspace.value?.github_installation_id) {
    state.value = 'select'
    await loadRepos()
  }
  else {
    state.value = 'install'
  }
})

const filteredRepos = computed(() => {
  if (!searchQuery.value) return repos.value
  const q = searchQuery.value.toLowerCase()
  return repos.value.filter(r =>
    r.fullName.toLowerCase().includes(q)
    || r.description?.toLowerCase().includes(q),
  )
})

async function loadRepos() {
  if (!activeWorkspace.value) return
  reposLoading.value = true
  try {
    repos.value = await $fetch('/api/github/repos', {
      params: { workspaceId: activeWorkspace.value.id },
    })
  }
  catch {
    repos.value = []
  }
  finally {
    reposLoading.value = false
  }
}

async function selectRepo(repo: typeof repos.value[0]) {
  selectedRepo.value = repo
  state.value = 'confirm'
  scanLoading.value = true

  try {
    scanResult.value = await $fetch('/api/github/scan', {
      params: {
        workspaceId: activeWorkspace.value!.id,
        owner: repo.owner,
        repo: repo.name,
      },
    })
  }
  catch {
    scanResult.value = null
  }
  finally {
    scanLoading.value = false
  }
}

function goBack() {
  state.value = 'select'
  selectedRepo.value = null
  scanResult.value = null
}

async function connectRepo() {
  if (!activeWorkspace.value || !selectedRepo.value) return
  connecting.value = true

  try {
    await $fetch(`/api/workspaces/${activeWorkspace.value.id}/projects`, {
      method: 'POST',
      body: {
        repoFullName: selectedRepo.value.fullName,
        defaultBranch: scanResult.value?.defaultBranch ?? selectedRepo.value.defaultBranch,
        detectedStack: scanResult.value?.stack ?? null,
        hasContentrain: scanResult.value?.hasContentDir ?? false,
      },
    })

    const { fetchProjects } = useProjects()
    await fetchProjects(activeWorkspace.value.id)

    toast.success(t('projects.connected_success'))
    open.value = false
  }
  catch (e: unknown) {
    const message = e instanceof Error ? e.message : t('projects.connected_error')
    toast.error(message)
  }
  finally {
    connecting.value = false
  }
}

function installGitHubApp() {
  window.open(
    'https://github.com/apps/contentrain-studio-dev/installations/new',
    '_blank',
  )
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogTrigger as-child>
      <slot />
    </DialogTrigger>

    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />

      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800"
        >
          <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
            {{ t('projects.connect_repo') }}
          </DialogTitle>
          <DialogDescription class="sr-only">
            {{ t('projects.empty_description') }}
          </DialogDescription>
          <DialogClose
            class="rounded-lg p-1.5 text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
            <span class="sr-only">{{ t('common.close') }}</span>
          </DialogClose>
        </div>

        <!-- STATE 1: Install GitHub App -->
        <div v-if="state === 'install'" class="px-6 py-12 text-center">
          <div
            class="mx-auto flex size-16 items-center justify-center rounded-2xl bg-secondary-50 dark:bg-secondary-900"
          >
            <span class="icon-[annon--link-1] text-2xl text-muted" aria-hidden="true" />
          </div>
          <AtomsHeadingText :level="3" size="xs" class="mt-5">
            {{ t('github.install_title') }}
          </AtomsHeadingText>
          <p class="mt-2 text-sm text-muted">
            {{ t('github.install_description') }}
          </p>
          <AtomsBaseButton size="md" class="mt-6" @click="installGitHubApp">
            <template #prepend>
              <span class="icon-[annon--external-link] size-4" aria-hidden="true" />
            </template>
            {{ t('github.install_button') }}
          </AtomsBaseButton>
          <p class="mt-4 text-xs text-muted">
            {{ t('github.install_hint') }}
          </p>
        </div>

        <!-- STATE 2: Select Repository -->
        <div v-else-if="state === 'select'" class="flex max-h-[60vh] flex-col">
          <!-- Search -->
          <div class="border-b border-secondary-200 px-6 py-3 dark:border-secondary-800">
            <AtomsFormInput v-model="searchQuery" type="search" :placeholder="t('common.search')" />
          </div>

          <!-- Repo list -->
          <div class="flex-1 overflow-y-auto px-3 py-2">
            <!-- Loading -->
            <div v-if="reposLoading" class="space-y-2 px-3 py-2">
              <AtomsSkeleton v-for="i in 5" :key="i" variant="custom" class="h-14 w-full rounded-lg" />
            </div>

            <!-- Empty -->
            <div v-else-if="filteredRepos.length === 0" class="px-3 py-8 text-center text-sm text-muted">
              {{ t('github.no_repos') }}
            </div>

            <!-- List -->
            <button
              v-for="repo in filteredRepos" v-else :key="repo.id" type="button"
              class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
              @click="selectRepo(repo)"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
                  {{ repo.fullName }}
                </div>
                <div v-if="repo.description" class="mt-0.5 truncate text-xs text-muted">
                  {{ repo.description }}
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <AtomsBadge v-if="repo.language" variant="secondary" size="sm">
                  {{ repo.language }}
                </AtomsBadge>
                <span v-if="repo.private" class="icon-[annon--lock] size-3.5 text-muted" aria-hidden="true" />
                <span class="icon-[annon--chevron-right] size-4 text-muted" aria-hidden="true" />
              </div>
            </button>
          </div>
        </div>

        <!-- STATE 3: Confirm -->
        <div v-else-if="state === 'confirm'" class="px-6 py-6">
          <!-- Selected repo header -->
          <div class="flex items-center gap-3">
            <div class="flex size-10 items-center justify-center rounded-lg bg-secondary-50 dark:bg-secondary-900">
              <span class="icon-[annon--folder] size-5 text-muted" aria-hidden="true" />
            </div>
            <div class="min-w-0 flex-1">
              <AtomsHeadingText :level="3" size="xs" truncate>
                {{ selectedRepo?.fullName }}
              </AtomsHeadingText>
              <p class="text-xs text-muted">
                {{ selectedRepo?.defaultBranch }}
              </p>
            </div>
          </div>

          <!-- Scan results -->
          <div class="mt-5 space-y-3">
            <!-- Loading -->
            <div v-if="scanLoading" class="space-y-3">
              <AtomsSkeleton v-for="i in 3" :key="i" variant="custom" class="h-8 w-full rounded-lg" />
            </div>

            <!-- Results -->
            <template v-else-if="scanResult">
              <div class="flex items-center gap-2.5 rounded-lg bg-secondary-50 px-3 py-2 dark:bg-secondary-900">
                <span class="icon-[annon--check-circle] size-4 text-success-500" aria-hidden="true" />
                <span class="text-sm text-body dark:text-secondary-300">
                  {{ scanResult.stack === 'unknown' ? t('github.unknown_framework')
                    : t('github.framework_detected').replace('{stack}', scanResult.stack.charAt(0).toUpperCase()
                      + scanResult.stack.slice(1)) }}
                </span>
              </div>
              <div class="flex items-center gap-2.5 rounded-lg bg-secondary-50 px-3 py-2 dark:bg-secondary-900">
                <span
                  :class="scanResult.hasContentDir ? 'icon-[annon--check-circle] text-success-500' : 'icon-[annon--alert-circle] text-warning-500'"
                  class="size-4" aria-hidden="true"
                />
                <span class="text-sm text-body dark:text-secondary-300">
                  {{ scanResult.hasContentDir ? t('github.contentrain_found') : t('github.contentrain_missing') }}
                </span>
              </div>
              <div class="flex items-center gap-2.5 rounded-lg bg-secondary-50 px-3 py-2 dark:bg-secondary-900">
                <span class="icon-[annon--check-circle] size-4 text-success-500" aria-hidden="true" />
                <span class="text-sm text-body dark:text-secondary-300">
                  {{ t('github.branch_label').replace('{branch}', scanResult.defaultBranch) }}
                </span>
              </div>
            </template>

            <!-- Scan failed -->
            <div
              v-else
              class="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700 dark:bg-danger-900/20 dark:text-danger-400"
            >
              {{ t('github.scan_failed') }}
            </div>
          </div>

          <!-- Actions -->
          <div class="mt-6 flex items-center justify-between">
            <AtomsBaseButton size="sm" @click="goBack">
              <template #prepend>
                <span class="icon-[annon--arrow-left] size-4" aria-hidden="true" />
              </template>
              <span>{{ t('common.back') }}</span>
            </AtomsBaseButton>
            <AtomsBaseButton size="md" :disabled="!scanResult || connecting" @click="connectRepo">
              <template v-if="connecting" #prepend>
                <div class="size-4 animate-spin rounded-full border-2 border-secondary-300 border-t-secondary-600" />
              </template>
              <span>{{ connecting ? t('common.connecting') : t('common.connect') }}</span>
            </AtomsBaseButton>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
