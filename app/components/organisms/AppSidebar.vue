<script setup lang="ts">
const { t } = useContent()
const { state: authState, signOut } = useAuth()
const { activeWorkspace } = useWorkspaces()
const { projects } = useProjects()
const route = useRoute()

const connectDialogOpen = ref(false)
const currentProjectId = computed(() => route.params.projectId as string | undefined)

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
</script>

<template>
  <aside
    class="flex h-screen w-60 flex-col border-r border-secondary-200 bg-white dark:border-secondary-800 dark:bg-secondary-950"
  >
    <!-- Logo -->
    <div class="flex shrink-0 items-end gap-2.5 px-4 pb-3 pt-5">
      <NuxtLink to="/" class="flex items-end gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50">
        <AtomsLogo variant="icon" color="white" class="h-8 w-auto" />
        <span class="mb-0.5 text-sm font-semibold uppercase tracking-[0.25em] text-secondary-400">Studio</span>
      </NuxtLink>
    </div>

    <!-- Workspace Switcher -->
    <div class="px-3 pb-1">
      <MoleculesWorkspaceSwitcher />
    </div>

    <!-- Scrollable nav -->
    <nav class="flex-1 overflow-y-auto px-3 py-3">
      <!-- Projects section -->
      <div class="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {{ t('sidebar.projects') }}
      </div>
      <ul class="space-y-0.5">
        <li v-for="link in sidebarLinks" :key="link.id">
          <NuxtLink
            :to="link.to"
            class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
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
            class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900 dark:hover:text-secondary-300"
            @click="connectDialogOpen = true"
          >
            <span class="icon-[annon--plus-circle] size-4 shrink-0" aria-hidden="true" />
            <span>{{ t('sidebar.connect_repo') }}</span>
          </button>
        </li>
      </ul>
    </nav>

    <!-- Footer -->
    <div class="shrink-0 border-t border-secondary-200 p-3 dark:border-secondary-800">
      <!-- Search shortcut -->
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
      >
        <span class="icon-[annon--search] size-4 shrink-0" aria-hidden="true" />
        <span>{{ t('common.search') }}</span>
        <kbd class="ml-auto rounded border border-secondary-200 bg-secondary-50 px-1.5 py-0.5 text-[10px] font-medium text-muted dark:border-secondary-700 dark:bg-secondary-800">
          ⌘K
        </kbd>
      </button>

      <!-- Settings -->
      <NuxtLink
        v-if="activeWorkspace"
        :to="`/w/${activeWorkspace.slug}/settings`"
        class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900 dark:hover:text-secondary-300"
      >
        <span class="icon-[annon--gear] size-4 shrink-0" aria-hidden="true" />
        <span>{{ t('common.settings') }}</span>
      </NuxtLink>

      <!-- User -->
      <div class="mt-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5">
        <AtomsAvatar
          :src="authState.user?.avatarUrl"
          :name="authState.user?.email"
          size="sm"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
            {{ authState.user?.email?.split('@')[0] }}
          </div>
          <div class="truncate text-[11px] text-muted">
            {{ authState.user?.email }}
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
    <!-- Connect Repo Dialog -->
    <OrganismsConnectRepoDialog v-model:open="connectDialogOpen" />
  </aside>
</template>
