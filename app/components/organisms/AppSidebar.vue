<script setup lang="ts">
const { t } = useContent()
const { state: authState, signOut } = useAuth()
const { activeWorkspace } = useWorkspaces()
const { projects } = useProjects()
const { models, hasContentrain, refreshing, snapshot } = useSnapshot()
const route = useRoute()
const { isDark, toggle: toggleTheme } = useTheme()

const router = useRouter()
const connectDialogOpen = ref(false)
const currentProjectId = computed(() => route.params.projectId as string | undefined)
const isInsideProject = computed(() => !!currentProjectId.value)
const activeModelId = computed(() => route.query.model as string | undefined)

const activeProject = computed(() =>
  projects.value.find(p => p.id === currentProjectId.value) ?? null,
)

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

// Group models by domain
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
  const content = snapshot.value?.content?.[modelId]
  if (!content) return null
  return content.count
}

function selectModel(modelId: string) {
  router.replace({ query: { ...route.query, model: modelId } })
}
</script>

<template>
  <aside
    class="flex h-screen w-60 flex-col border-r border-secondary-200 bg-white dark:border-secondary-800 dark:bg-secondary-950"
  >
    <!-- Brand + Workspace -->
    <div class="shrink-0 px-3 pt-3 pb-2">
      <!-- Logo mark -->
      <NuxtLink to="/" class="mb-1 flex items-center gap-2 px-2 focus-visible:outline-none">
        <AtomsLogo variant="icon" color="auto" class="h-5 w-auto" />
        <span class="text-[11px] font-semibold uppercase tracking-[0.2em] text-secondary-400">Studio</span>
      </NuxtLink>
      <!-- Workspace switcher -->
      <MoleculesWorkspaceSwitcher />
    </div>

    <!-- Scrollable nav -->
    <nav class="flex-1 overflow-y-auto px-3 py-1">
      <!-- PROJECT VIEW: show project name + models grouped by domain -->
      <template v-if="isInsideProject">
        <!-- Active project + back nav (single compact row) -->
        <div class="mb-2 flex items-center gap-1.5 px-2">
          <NuxtLink
            v-if="activeWorkspace"
            :to="`/w/${activeWorkspace.slug}`"
            class="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
            :title="t('sidebar.projects')"
          >
            <span class="icon-[annon--arrow-left] block size-3.5" aria-hidden="true" />
          </NuxtLink>
          <span v-if="activeProject" class="min-w-0 truncate text-[13px] font-semibold text-heading dark:text-secondary-100">
            {{ activeProject.repo_full_name }}
          </span>
        </div>

        <!-- Models grouped by domain -->
        <template v-if="hasContentrain">
          <div
            v-for="(domainModels, domain) in modelsByDomain"
            :key="domain"
            class="mt-2"
          >
            <div class="mb-0.5 flex items-center gap-1.5 px-2 py-1">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {{ domain }}
              </span>
              <div
                v-if="refreshing"
                class="size-2.5 animate-spin rounded-full border border-secondary-300 border-t-primary-500 dark:border-secondary-600 dark:border-t-primary-400"
              />
            </div>
            <ul class="space-y-px">
              <li v-for="model in domainModels" :key="model.id">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  :class="activeModelId === model.id
                    ? 'bg-primary-50 text-primary-700 font-medium dark:bg-primary-900/20 dark:text-primary-400'
                    : 'text-body hover:bg-secondary-50 dark:text-secondary-400 dark:hover:bg-secondary-900'
                  "
                  @click="selectModel(model.id)"
                >
                  <span
                    :class="getModelKindIcon(model.kind ?? model.type)"
                    class="size-3.5 shrink-0 opacity-50"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 truncate text-left">{{ model.name }}</span>
                  <span
                    v-if="(model as any).i18n"
                    class="icon-[annon--globe] size-3 shrink-0 opacity-30"
                    aria-hidden="true"
                    title="i18n"
                  />
                  <span v-if="getModelEntryCount(model.id) !== null" class="shrink-0 text-[10px] tabular-nums text-disabled">
                    {{ getModelEntryCount(model.id) }}
                  </span>
                </button>
              </li>
            </ul>
          </div>
        </template>
      </template>

      <!-- DASHBOARD VIEW: show project list -->
      <template v-else>
        <div class="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
          {{ t('sidebar.projects') }}
        </div>
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
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900 dark:hover:text-secondary-300"
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
    <div class="shrink-0 space-y-0.5 border-t border-secondary-200 p-2 dark:border-secondary-800">
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
      >
        <span class="icon-[annon--search] size-4 shrink-0" aria-hidden="true" />
        <span>{{ t('common.search') }}</span>
        <kbd class="ml-auto rounded border border-secondary-200 bg-secondary-50 px-1.5 py-0.5 text-[10px] font-medium text-muted dark:border-secondary-700 dark:bg-secondary-800">
          ⌘K
        </kbd>
      </button>

      <NuxtLink
        v-if="activeWorkspace"
        :to="`/w/${activeWorkspace.slug}/settings`"
        class="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900 dark:hover:text-secondary-300"
      >
        <span class="icon-[annon--gear] size-4 shrink-0" aria-hidden="true" />
        <span>{{ t('common.settings') }}</span>
      </NuxtLink>

      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
        @click="toggleTheme"
      >
        <span :class="isDark ? 'icon-[annon--sun]' : 'icon-[annon--moon]'" class="size-4 shrink-0" aria-hidden="true" />
        <span>{{ isDark ? 'Light mode' : 'Dark mode' }}</span>
      </button>

      <!-- User -->
      <div class="flex items-center gap-2.5 rounded-md px-2 py-1.5">
        <AtomsAvatar
          :src="authState.user?.avatarUrl"
          :name="authState.user?.email"
          size="sm"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
            {{ authState.user?.email?.split('@')[0] }}
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
          @click="signOut"
        >
          <span class="icon-[annon--log-out] block size-4" aria-hidden="true" />
          <span class="sr-only">{{ t('common.sign_out') }}</span>
        </button>
      </div>
    </div>

    <OrganismsConnectRepoDialog v-model:open="connectDialogOpen" />
  </aside>
</template>
