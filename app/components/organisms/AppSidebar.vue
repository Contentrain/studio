<script setup lang="ts">
const { t } = useContent()
const { state: authState, signOut } = useAuth()
const { activeWorkspace } = useWorkspaces()
const { projects } = useProjects()
const { models, hasContentrain, snapshot, loading: snapshotLoading, fetchSnapshot, invalidateCache } = useSnapshot()
const { branches, fetchBranches } = useBranches()
const route = useRoute()
const { isDark, toggle: toggleTheme } = useTheme()
const { toggle: openCommandPalette, pendingAction, consumeAction } = useCommandPalette()
const { isOwnerOrAdmin } = useWorkspaceRole()

const router = useRouter()
const connectDialogOpen = ref(false)
const settingsModalOpen = ref(false)
const settingsModalTab = ref<'general' | 'api' | 'webhooks'>('general')

// Consume pending actions from CommandPalette (only sidebar-owned dialogs)
watch(pendingAction, (action) => {
  if (!action) return

  switch (action.type) {
    case 'open-project-settings':
      consumeAction()
      settingsModalTab.value = (action.payload as 'general' | 'api' | 'webhooks') ?? 'general'
      settingsModalOpen.value = true
      break
    case 'connect-repo':
      consumeAction()
      connectDialogOpen.value = true
      break
    // 'send-prompt' is consumed by the project page (chatPanelRef)
  }
})
const currentProjectId = computed(() => route.params.projectId as string | undefined)
const isInsideProject = computed(() => !!currentProjectId.value)
const currentProject = computed(() => projects.value.find(p => p.id === currentProjectId.value) ?? null)
const projectConfig = computed(() => snapshot.value?.config as {
  workflow?: string
  stack?: string
  domains?: string[]
  locales?: { default?: string, supported?: string[] }
} | null)
const activeModelId = computed(() => route.query.model as string | undefined)
const isVocabularyActive = computed(() => (route.query as Record<string, string | undefined>).vocabulary === 'true')
const vocabularyCount = computed(() => {
  const vocab = snapshot.value?.vocabulary as Record<string, unknown> | null | undefined
  return vocab ? Object.keys(vocab).length : 0
})
const activeBranch = computed(() => {
  const b = (route.query as Record<string, string | undefined>).branch
  return b ? decodeURIComponent(b) : null
})
const isCDNActive = computed(() => (route.query as Record<string, string | undefined>).cdn === 'true')
const isAssetsActive = computed(() => (route.query as Record<string, string | undefined>).assets === 'true')
const isPro = computed(() => hasFeature(activeWorkspace.value?.plan, 'cdn.delivery'))
const hasMedia = computed(() => hasFeature(activeWorkspace.value?.plan, 'media.library'))
const { healthScore } = useProjectHealth()

// Fetch branches when project/workspace context becomes available.
watch(
  () => [currentProjectId.value, activeWorkspace.value?.id] as const,
  async ([id, workspaceId]) => {
    if (id && workspaceId) {
      await fetchBranches(workspaceId, id)
    }
  },
  { immediate: true },
)

const sidebarLinks = computed(() => {
  if (!activeWorkspace.value) return []
  const slug = activeWorkspace.value.slug
  return projects.value.map(p => ({
    id: p.id,
    label: p.repo_full_name.split('/').pop() ?? p.repo_full_name,
    to: `/w/${slug}/projects/${p.id}`,
    active: p.id === currentProjectId.value,
  }))
})

const modelsByDomain = computed(() => {
  const groups: Record<string, Array<typeof models.value[number]>> = {}
  for (const model of models.value) {
    const domain = model.domain ?? 'other'
    if (!groups[domain]) groups[domain] = []
    groups[domain]!.push(model)
  }
  return groups
})

function getModelEntryCount(modelId: string): number | null {
  return snapshot.value?.content?.[modelId]?.count ?? null
}

function selectModel(modelId: string) {
  const query: Record<string, string> = { model: modelId }
  router.replace({ query })
}

function selectBranch(branchName: string) {
  const query: Record<string, string> = { branch: encodeURIComponent(branchName) }
  router.replace({ query })
}

function selectVocabulary() {
  router.replace({ query: { vocabulary: 'true' } })
}

function selectCDN() {
  router.replace({ query: { cdn: 'true' } })
}

function selectAssets() {
  router.replace({ query: { assets: 'true' } })
}

function installGitHubApp() {
  window.open(
    getGitHubAppInstallUrl(),
    '_blank',
    'noopener,noreferrer',
  )
}

function backToWorkspace() {
  if (!activeWorkspace.value) return
  router.push(`/w/${activeWorkspace.value.slug}`)
}

async function onSettingsSaved() {
  if (!activeWorkspace.value || !currentProjectId.value) return
  await invalidateCache(currentProjectId.value)
  await fetchSnapshot(activeWorkspace.value.id, currentProjectId.value)
}

function onProjectDeleted() {
  settingsModalOpen.value = false
  backToWorkspace()
}
</script>

<template>
  <aside
    class="flex h-screen w-60 flex-col border-r border-secondary-200 bg-white dark:border-secondary-800 dark:bg-secondary-950"
  >
    <!-- Brand + Workspace -->
    <div class="shrink-0 px-3 pt-3 pb-2">
      <NuxtLink to="/" class="mb-1 flex items-end gap-2 rounded px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50">
        <AtomsLogo variant="icon" color="auto" class="h-5 w-auto" />
        <span
          class="font-display text-[11px] leading-none font-semibold uppercase tracking-[0.2em] text-secondary-400"
        >Studio</span>
      </NuxtLink>
      <MoleculesWorkspaceSwitcher />
    </div>

    <!-- Scrollable nav -->
    <nav class="flex-1 overflow-y-auto px-3 py-1">
      <!-- PROJECT VIEW -->
      <template v-if="isInsideProject">
        <!-- Project header -->
        <div class="mb-1 flex items-center gap-1.5 rounded-md px-2 py-1.5">
          <span class="icon-[annon--folder] size-4 shrink-0 text-primary-500" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-heading dark:text-secondary-100">
            {{ currentProject?.repo_full_name?.split('/')[1] ?? currentProjectId }}
          </span>
          <span
            v-if="hasContentrain && healthScore < 90"
            class="size-1.5 shrink-0 rounded-full"
            :class="healthScore >= 70 ? 'bg-warning-400' : 'bg-danger-400'"
            :title="`${t('health.score_label')}: ${healthScore}/100`"
          />
          <AtomsIconButton
            v-if="isOwnerOrAdmin" icon="icon-[annon--gear]" :label="t('project_settings.title')"
            size="sm" @click="settingsModalOpen = true"
          />
          <AtomsIconButton icon="icon-[annon--cross]" :label="t('common.back')" size="sm" @click="backToWorkspace" />
        </div>

        <!-- Sidebar skeleton while loading (snapshotLoading OR no snapshot yet) -->
        <div v-if="snapshotLoading || !snapshot" class="space-y-2 px-1 py-1">
          <AtomsSkeleton variant="custom" class="h-3 w-20 rounded" />
          <AtomsSkeleton v-for="i in 4" :key="i" variant="custom" class="h-7 w-full rounded-md" />
          <AtomsSkeleton variant="custom" class="mt-3 h-3 w-24 rounded" />
          <AtomsSkeleton v-for="i in 2" :key="`b${i}`" variant="custom" class="h-7 w-full rounded-md" />
        </div>

        <template v-else-if="hasContentrain">
          <details v-for="(domainModels, domain) in modelsByDomain" :key="domain" class="group mt-2 first:mt-0" open>
            <summary
              class="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-primary-900/20"
            >
              <span
                class="icon-[annon--chevron-right] size-3 shrink-0 text-muted transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              <AtomsSectionLabel :label="String(domain)" :count="domainModels.length" class="flex-1 py-0" />
            </summary>
            <ul class="space-y-px py-0.5 pl-4">
              <li v-for="model in domainModels" :key="model.id">
                <MoleculesSidebarItem
                  :icon="getModelKindIcon(model.kind ?? model.type)" :label="model.name"
                  :active="activeModelId === model.id" :count="getModelEntryCount(model.id)" compact
                  @click="selectModel(model.id)"
                >
                  <template #trailing>
                    <span
                      v-if="model.i18n" class="icon-[annon--globe] size-3 shrink-0 opacity-30"
                      aria-hidden="true" :title="t('common.i18n')"
                    />
                  </template>
                </MoleculesSidebarItem>
              </li>
            </ul>
          </details>
        </template>

        <!-- Project resources -->
        <div v-if="hasContentrain" class="mt-2 space-y-px">
          <MoleculesSidebarItem
            icon="icon-[annon--book-library]" :label="t('content.vocabulary')"
            :active="isVocabularyActive" :count="vocabularyCount" compact @click="selectVocabulary"
          />

          <!-- CDN (Pro feature) -->
          <MoleculesSidebarItem
            icon="icon-[annon--globe]" :label="t('cdn.title')" :active="isCDNActive" compact
            @click="selectCDN"
          >
            <template #trailing>
              <AtomsBadge v-if="!isPro" variant="info" size="sm" class="text-[9px] px-1 py-0">
                Pro
              </AtomsBadge>
            </template>
          </MoleculesSidebarItem>

          <!-- Assets (Pro feature) -->
          <MoleculesSidebarItem
            icon="icon-[annon--image]" :label="t('media.title')" :active="isAssetsActive" compact
            @click="selectAssets"
          >
            <template #trailing>
              <AtomsBadge v-if="!hasMedia" variant="info" size="sm" class="text-[9px] px-1 py-0">
                Pro
              </AtomsBadge>
            </template>
          </MoleculesSidebarItem>
        </div>

        <!-- Pending branches -->
        <div v-if="branches.length > 0" class="mt-3">
          <AtomsSectionLabel :label="t('sidebar.pending_changes')" :count="branches.length" class="mb-0.5" />
          <ul class="space-y-px">
            <li v-for="branch in branches" :key="branch.name">
              <MoleculesSidebarItem
                icon="icon-[annon--arrow-swap]" :label="branch.name.replace('contentrain/', '')"
                :active="activeBranch === branch.name" compact @click="selectBranch(branch.name)"
              />
            </li>
          </ul>
        </div>
      </template>

      <!-- DASHBOARD VIEW -->
      <template v-else>
        <AtomsSectionLabel :label="t('sidebar.projects')" class="mb-1" />

        <!-- No installation → prompt to install GitHub App -->
        <div v-if="activeWorkspace && !activeWorkspace.github_installation_id && isOwnerOrAdmin" class="px-2 py-4">
          <div class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-secondary-300 px-3 py-4 text-center dark:border-secondary-700">
            <span class="icon-[annon--link-1] size-5 text-muted" aria-hidden="true" />
            <p class="text-xs text-muted">
              {{ t('sidebar.install_github_hint') }}
            </p>
            <AtomsBaseButton size="sm" variant="primary" @click="installGitHubApp">
              <template #prepend>
                <span class="icon-[annon--external-link] size-3.5" aria-hidden="true" />
              </template>
              {{ t('github.install_button') }}
            </AtomsBaseButton>
          </div>
        </div>

        <!-- Projects list -->
        <ul v-else class="space-y-px">
          <li v-for="link in sidebarLinks" :key="link.id">
            <NuxtLink
              :to="link.to"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
              :class="link.active
                ? 'border-l-2 border-primary-500 pl-1.5 bg-primary-50 text-primary-700 font-medium dark:bg-primary-900/20 dark:text-primary-400'
                : 'text-body hover:bg-primary-50 hover:text-primary-700 dark:text-secondary-400 dark:hover:bg-primary-900/20 dark:hover:text-primary-400'
              "
            >
              <span
                class="icon-[annon--folder] size-4 shrink-0" :class="link.active ? 'opacity-100' : 'opacity-60'"
                aria-hidden="true"
              />
              <span class="min-w-0 truncate">{{ link.label }}</span>
            </NuxtLink>
          </li>
          <li v-if="activeWorkspace && isOwnerOrAdmin" class="pt-1">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md border border-dashed border-secondary-300 px-2 py-1.5 text-sm text-muted transition-colors hover:border-primary-400 hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-700 dark:hover:border-primary-500 dark:hover:text-primary-400"
              @click="connectDialogOpen = true"
            >
              <span class="icon-[annon--plus-circle] size-4 shrink-0" aria-hidden="true" />
              <span>{{ t('sidebar.connect_repo') }}</span>
            </button>
          </li>
        </ul>
      </template>
    </nav>

    <!-- Footer -->
    <div class="shrink-0 border-t border-secondary-200 dark:border-secondary-800">
      <!-- Tools -->
      <div class="space-y-0.5 px-2 pt-2 pb-1">
        <MoleculesSidebarItem icon="icon-[annon--search]" :label="t('common.search')" @click="openCommandPalette">
          <template #trailing>
            <kbd
              class="ml-auto rounded border border-secondary-200 bg-secondary-50 px-1.5 py-0.5 text-[10px] font-medium text-muted dark:border-secondary-700 dark:bg-secondary-800"
            >
              ⌘K
            </kbd>
          </template>
        </MoleculesSidebarItem>

        <NuxtLink
          v-if="activeWorkspace" :to="`/w/${activeWorkspace.slug}/settings`"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-primary-900/20 dark:hover:text-primary-400"
        >
          <span class="icon-[annon--gear] size-4 shrink-0" aria-hidden="true" />
          <span>{{ t('common.settings') }}</span>
        </NuxtLink>

        <MoleculesSidebarItem
          :icon="isDark ? 'icon-[annon--sun]' : 'icon-[annon--moon]'"
          :label="isDark ? t('common.light_mode') : t('common.dark_mode')" @click="toggleTheme"
        />
      </div>

      <!-- User -->
      <div class="border-t border-secondary-100 px-2 py-2 dark:border-secondary-800/50">
        <div class="flex items-center gap-2.5 rounded-md px-2 py-1.5">
          <AtomsAvatar :src="authState.user?.avatarUrl" :name="authState.user?.email" size="sm" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
              {{ authState.user?.email?.split('@')[0] }}
            </div>
          </div>
          <AtomsIconButton icon="icon-[annon--log-out]" :label="t('common.sign_out')" @click="signOut" />
        </div>
      </div>
    </div>

    <OrganismsConnectRepoDialog v-model:open="connectDialogOpen" />

    <OrganismsProjectSettingsModal
      v-if="isInsideProject && activeWorkspace && currentProjectId"
      v-model:open="settingsModalOpen" :workspace-id="activeWorkspace.id" :project-id="currentProjectId"
      :initial-tab="settingsModalTab"
      :project-name="currentProject?.repo_full_name?.split('/').pop() ?? ''"
      :config="projectConfig" @saved="onSettingsSaved" @deleted="onProjectDeleted"
    />
  </aside>
</template>
