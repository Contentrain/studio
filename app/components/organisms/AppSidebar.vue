<script setup lang="ts">
const { t } = useContent()
const { state: authState, signOut } = useAuth()
const { activeWorkspace } = useWorkspaces()
const { projects } = useProjects()
const { models, hasContentrain, snapshot, loading: snapshotLoading, fetchSnapshot, invalidateCache } = useSnapshot()
const { branches, fetchBranches } = useBranches()
const route = useRoute()
const { isDark, toggle: toggleTheme } = useTheme()
const { toggle: openCommandPalette } = useCommandPalette()

const router = useRouter()
const connectDialogOpen = ref(false)
const settingsModalOpen = ref(false)
const currentProjectId = computed(() => route.params.projectId as string | undefined)
const isInsideProject = computed(() => !!currentProjectId.value)
const currentProject = computed(() => projects.value.find(p => p.id === currentProjectId.value) ?? null)
const projectConfig = computed(() => snapshot.value?.config as Record<string, unknown> | null)
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
const isPro = computed(() => hasFeature(activeWorkspace.value?.plan, 'cdn.delivery'))

// Fetch branches when inside a project
watch(isInsideProject, async (inside) => {
  if (inside && activeWorkspace.value && currentProjectId.value) {
    await fetchBranches(activeWorkspace.value.id, currentProjectId.value)
  }
}, { immediate: true })

const sidebarLinks = computed(() => {
  if (!activeWorkspace.value) return []
  const slug = activeWorkspace.value.slug
  return projects.value.map(p => ({
    id: p.id,
    label: p.repo_full_name,
    to: `/w/${slug}/projects/${p.id}`,
    active: p.id === currentProjectId.value,
  }))
})

const modelsByDomain = computed(() => {
  const groups: Record<string, typeof models.value> = {}
  for (const model of models.value) {
    const domain = (model as { domain?: string }).domain ?? 'other'
    if (!groups[domain]) groups[domain] = []
    groups[domain].push(model)
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

function backToWorkspace() {
  if (!activeWorkspace.value) return
  router.push(`/w/${activeWorkspace.value.slug}`)
}

async function onSettingsSaved() {
  if (!activeWorkspace.value || !currentProjectId.value) return
  await invalidateCache(currentProjectId.value)
  await fetchSnapshot(activeWorkspace.value.id, currentProjectId.value)
}
</script>

<template>
  <aside
    class="flex h-screen w-60 flex-col border-r border-secondary-200 bg-white dark:border-secondary-800 dark:bg-secondary-950"
  >
    <!-- Brand + Workspace -->
    <div class="shrink-0 px-3 pt-3 pb-2">
      <NuxtLink to="/" class="mb-1 flex items-end gap-2 px-2 focus-visible:outline-none">
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
          <AtomsIconButton
            icon="icon-[annon--gear]" :label="t('project_settings.title')" size="sm"
            @click="settingsModalOpen = true"
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
          <details v-for="(domainModels, domain) in modelsByDomain" :key="domain" class="group mt-1" open>
            <summary
              class="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
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
                      v-if="(model as any).i18n" class="icon-[annon--globe] size-3 shrink-0 opacity-30"
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
          <div :class="!isPro ? 'opacity-60' : ''">
            <MoleculesSidebarItem
              icon="icon-[annon--globe]" :label="t('cdn.title')"
              :active="isCDNActive" compact @click="selectCDN"
            >
              <template #trailing>
                <AtomsBadge v-if="!isPro" variant="info" size="sm" class="text-[9px] px-1 py-0">
                  Pro
                </AtomsBadge>
              </template>
            </MoleculesSidebarItem>
          </div>

          <!-- Assets (Phase 4 — placeholder, always shows Pro badge for now) -->
          <div class="opacity-60">
            <MoleculesSidebarItem
              icon="icon-[annon--image]" label="Assets"
              compact :disabled="true"
            >
              <template #trailing>
                <AtomsBadge variant="info" size="sm" class="text-[9px] px-1 py-0">
                  Pro
                </AtomsBadge>
              </template>
            </MoleculesSidebarItem>
          </div>
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
        <ul class="space-y-px">
          <li v-for="link in sidebarLinks" :key="link.id">
            <NuxtLink
              :to="link.to"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
              :class="link.active
                ? 'bg-primary-50 text-primary-700 font-medium dark:bg-primary-900/20 dark:text-primary-400'
                : 'text-body hover:bg-secondary-50 dark:text-secondary-400 dark:hover:bg-secondary-900'
              "
            >
              <span class="icon-[annon--folder] size-4 shrink-0" aria-hidden="true" />
              <span class="min-w-0 truncate">{{ link.label }}</span>
            </NuxtLink>
          </li>
          <li v-if="activeWorkspace">
            <MoleculesSidebarItem
              icon="icon-[annon--plus-circle]" :label="t('sidebar.connect_repo')"
              @click="connectDialogOpen = true"
            />
          </li>
        </ul>
      </template>
    </nav>

    <!-- Footer -->
    <div class="shrink-0 space-y-0.5 border-t border-secondary-200 p-2 dark:border-secondary-800">
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
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900 dark:hover:text-secondary-300"
      >
        <span class="icon-[annon--gear] size-4 shrink-0" aria-hidden="true" />
        <span>{{ t('common.settings') }}</span>
      </NuxtLink>

      <MoleculesSidebarItem
        :icon="isDark ? 'icon-[annon--sun]' : 'icon-[annon--moon]'"
        :label="isDark ? t('common.light_mode') : t('common.dark_mode')" @click="toggleTheme"
      />

      <!-- User -->
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

    <OrganismsConnectRepoDialog v-model:open="connectDialogOpen" />

    <OrganismsProjectSettingsModal
      v-if="isInsideProject && activeWorkspace && currentProjectId"
      v-model:open="settingsModalOpen" :workspace-id="activeWorkspace.id" :project-id="currentProjectId"
      :config="(projectConfig as any)" @saved="onSettingsSaved"
    />
  </aside>
</template>
