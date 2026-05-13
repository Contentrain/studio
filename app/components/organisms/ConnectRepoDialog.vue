<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger } from 'radix-vue'

const { t } = useContent()
const { activeWorkspace } = useWorkspaces()
const toast = useToast()

const open = defineModel<boolean>('open', { default: false })

// State machine
type DialogState = 'install' | 'connect-existing' | 'select' | 'confirm'

interface AvailableInstallation {
  id: number
  account: {
    login: string | null
    avatarUrl: string | null
    type: string | null
  }
  repositorySelection: 'all' | 'selected' | null
  targetType: 'User' | 'Organization' | string | null
  boundWorkspace: { id: string, name: string, slug: string } | null
}

const state = ref<DialogState>('install')
const availableInstallations = ref<AvailableInstallation[]>([])
const availableLoading = ref(false)
const availableError = ref<'unauthorized' | 'generic' | null>(null)
const connectingInstallation = ref<number | null>(null)
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
    availableInstallations.value = []
    availableError.value = null
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
    repos.value = await $fetch<typeof repos.value>('/api/github/repos', {
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
    scanResult.value = await $fetch<NonNullable<typeof scanResult.value>>('/api/github/scan', {
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
    toast.error(resolveApiError(e, t('projects.connected_error')))
  }
  finally {
    connecting.value = false
  }
}

function installGitHubApp() {
  if (!activeWorkspace.value) return
  window.open(
    getGitHubAppInstallUrl(activeWorkspace.value.id),
    '_blank',
    'noopener,noreferrer',
  )
}

async function openConnectExisting() {
  if (!activeWorkspace.value) return
  state.value = 'connect-existing'
  availableLoading.value = true
  availableError.value = null
  availableInstallations.value = []

  try {
    const result = await $fetch<{ installations: AvailableInstallation[] }>(
      '/api/github/installations/available',
      { params: { workspaceId: activeWorkspace.value.id } },
    )
    availableInstallations.value = result.installations
  }
  catch (e: unknown) {
    const status = (e as { statusCode?: number, data?: { data?: { code?: string } } }).statusCode
    const code = (e as { data?: { data?: { code?: string } } }).data?.data?.code
    if (status === 401 || code === 'GITHUB_REAUTH_REQUIRED') {
      availableError.value = 'unauthorized'
    }
    else {
      availableError.value = 'generic'
    }
  }
  finally {
    availableLoading.value = false
  }
}

async function connectExistingInstallation(installation: AvailableInstallation) {
  if (!activeWorkspace.value || installation.boundWorkspace) return
  connectingInstallation.value = installation.id

  try {
    await $fetch('/api/github/installations/connect', {
      method: 'POST',
      body: {
        workspaceId: activeWorkspace.value.id,
        installationId: installation.id,
      },
    })

    // Refresh workspace so github_installation_id is current, then load repos.
    const { fetchWorkspaces } = useWorkspaces()
    await fetchWorkspaces()
    state.value = 'select'
    await loadRepos()
  }
  catch (e: unknown) {
    toast.error(resolveApiError(e, t('github.connect_existing_error')))
  }
  finally {
    connectingInstallation.value = null
  }
}

function reconnectGitHub() {
  // Trigger Supabase GitHub OAuth flow; on return the OAuth callback
  // captures and persists provider_token. After success, the user
  // re-opens this dialog and the available list resolves.
  window.location.href = `/api/auth/login?provider=github&redirect_to=${encodeURIComponent(window.location.pathname + window.location.search)}`
}

// Auto-detect GitHub App installation when user returns to tab
const checkingInstall = ref(false)

async function onWindowFocus() {
  // Only check when dialog is open and in install state
  if (!open.value || state.value !== 'install' || checkingInstall.value) return
  if (!activeWorkspace.value) return

  checkingInstall.value = true
  try {
    // Re-fetch workspace to check if installation_id is set
    const { fetchWorkspaces } = useWorkspaces()
    await fetchWorkspaces()

    // Check updated workspace
    if (activeWorkspace.value?.github_installation_id) {
      state.value = 'select'
      await loadRepos()
    }
  }
  finally {
    checkingInstall.value = false
  }
}

onMounted(() => window.addEventListener('focus', onWindowFocus))
onUnmounted(() => window.removeEventListener('focus', onWindowFocus))
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

          <!-- Or connect an existing installation -->
          <div class="mx-auto mt-6 flex max-w-xs items-center gap-3">
            <div class="h-px flex-1 bg-secondary-200 dark:bg-secondary-800" />
            <span class="text-xs uppercase tracking-wider text-disabled">{{ t('common.or') }}</span>
            <div class="h-px flex-1 bg-secondary-200 dark:bg-secondary-800" />
          </div>
          <button
            type="button"
            class="mt-4 inline-flex items-center gap-1.5 rounded text-sm text-primary-600 transition-colors hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400 dark:hover:text-primary-300"
            @click="openConnectExisting"
          >
            <span class="icon-[annon--link-1] size-3.5" aria-hidden="true" />
            <span>{{ t('github.connect_existing_button') }}</span>
          </button>
          <p class="mt-2 text-xs text-muted">
            {{ t('github.connect_existing_hint') }}
          </p>

          <!-- Auto-checking indicator -->
          <div v-if="checkingInstall" class="mt-3 flex items-center justify-center gap-2 text-xs text-muted">
            <div class="size-3 animate-spin rounded-full border-2 border-secondary-300 border-t-primary-500" />
            <span>{{ t('common.loading') }}</span>
          </div>
        </div>

        <!-- STATE: Connect existing installation -->
        <div v-else-if="state === 'connect-existing'" class="flex max-h-[60vh] flex-col">
          <!-- Header sub-row -->
          <div class="flex items-center gap-3 border-b border-secondary-200 px-6 py-3 dark:border-secondary-800">
            <button
              type="button"
              class="rounded p-1 text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
              @click="state = 'install'"
            >
              <span class="icon-[annon--arrow-left] block size-4" aria-hidden="true" />
              <span class="sr-only">{{ t('common.back') }}</span>
            </button>
            <p class="text-sm font-medium text-heading dark:text-secondary-100">
              {{ t('github.connect_existing_picker_title') }}
            </p>
          </div>

          <!-- Body -->
          <div class="flex-1 overflow-y-auto px-3 py-2">
            <!-- Reauth required -->
            <div v-if="availableError === 'unauthorized'" class="px-3 py-6">
              <AtomsEmptyState
                icon="icon-[annon--alert-circle]"
                :title="t('github.user_token_missing_title')"
                :description="t('github.user_token_missing')"
              >
                <template #action>
                  <AtomsBaseButton size="sm" variant="primary" @click="reconnectGitHub">
                    <template #prepend>
                      <span class="icon-[annon--arrow-swap] size-3.5" aria-hidden="true" />
                    </template>
                    {{ t('github.reconnect_button') }}
                  </AtomsBaseButton>
                </template>
              </AtomsEmptyState>
            </div>

            <!-- Generic error -->
            <div v-else-if="availableError === 'generic'" class="px-3 py-6">
              <AtomsEmptyState
                icon="icon-[annon--alert-triangle]"
                :title="t('github.connect_existing_error')"
                :description="t('github.connect_existing_error_hint')"
              />
            </div>

            <!-- Loading -->
            <div v-else-if="availableLoading" class="space-y-2 px-3 py-2">
              <AtomsSkeleton v-for="i in 3" :key="i" variant="custom" class="h-14 w-full rounded-lg" />
            </div>

            <!-- Empty -->
            <div v-else-if="availableInstallations.length === 0" class="px-3 py-6">
              <AtomsEmptyState
                icon="icon-[annon--search]"
                :title="t('github.no_existing_installations')"
                :description="t('github.no_existing_installations_hint')"
              >
                <template #action>
                  <AtomsBaseButton size="sm" variant="primary" @click="installGitHubApp">
                    <template #prepend>
                      <span class="icon-[annon--external-link] size-3.5" aria-hidden="true" />
                    </template>
                    {{ t('github.install_button') }}
                  </AtomsBaseButton>
                </template>
              </AtomsEmptyState>
            </div>

            <!-- List -->
            <ul v-else class="space-y-1">
              <li v-for="inst in availableInstallations" :key="inst.id">
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-secondary-900"
                  :disabled="!!inst.boundWorkspace || connectingInstallation === inst.id"
                  @click="connectExistingInstallation(inst)"
                >
                  <AtomsAvatar
                    v-if="inst.account.avatarUrl"
                    :src="inst.account.avatarUrl"
                    :name="inst.account.login"
                    size="sm"
                  />
                  <div v-else class="flex size-8 items-center justify-center rounded-full bg-secondary-100 dark:bg-secondary-800">
                    <span class="icon-[annon--user] size-4 text-muted" aria-hidden="true" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-sm font-medium text-heading dark:text-secondary-100">
                        {{ inst.account.login ?? '—' }}
                      </span>
                      <AtomsBadge :variant="inst.targetType === 'Organization' ? 'info' : 'secondary'" size="sm">
                        {{ inst.targetType === 'Organization' ? t('settings.github_org') : t('settings.github_user') }}
                      </AtomsBadge>
                    </div>
                    <div v-if="inst.boundWorkspace" class="mt-0.5 truncate text-xs text-muted">
                      {{ t('github.installation_already_bound').replace('{workspace}', inst.boundWorkspace.name) }}
                    </div>
                  </div>
                  <div v-if="connectingInstallation === inst.id" class="size-4 shrink-0 animate-spin rounded-full border-2 border-secondary-300 border-t-primary-500" />
                  <span v-else-if="!inst.boundWorkspace" class="icon-[annon--chevron-right] size-4 shrink-0 text-muted" aria-hidden="true" />
                </button>
              </li>
            </ul>
          </div>
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
            <div v-else-if="filteredRepos.length === 0" class="px-3 py-8">
              <AtomsEmptyState
                icon="icon-[annon--search]"
                :title="t('github.no_repos')"
                :description="t('github.no_repos_hint')"
                compact
              />
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
