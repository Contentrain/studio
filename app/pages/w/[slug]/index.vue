<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const route = useRoute()
const slug = computed(() => route.params.slug as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace, saveLastPath } = useWorkspaces()
const { projects, loading, fetchProjects } = useProjects()
const { t } = useContent()

const connectDialogOpen = ref(false)
const starterDialogOpen = ref(false)

// Persist current path
const router = useRouter()

onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) {
    saveLastPath('/')
    await router.replace('/')
    return
  }
  setActiveWorkspace(ws.id)
  await fetchProjects(ws.id)
  // Only persist path after confirming workspace exists
  saveLastPath(route.fullPath)
})

watch(() => route.fullPath, (path) => {
  // Only save if we're on a valid workspace route (not during redirect)
  if (activeWorkspace.value) saveLastPath(path)
})

watch(slug, async (newSlug) => {
  const ws = workspaces.value.find(w => w.slug === newSlug)
  if (!ws) {
    await router.replace('/')
    return
  }
  setActiveWorkspace(ws.id)
  await fetchProjects(ws.id)
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8 lg:px-8">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <AtomsHeadingText :level="1" size="lg">
          {{ t('projects.title') }}
        </AtomsHeadingText>
        <p v-if="activeWorkspace" class="mt-1 text-sm text-muted">
          {{ projects.length }} {{ projects.length === 1 ? t('projects.count_singular') : t('projects.count_plural') }}
        </p>
      </div>
      <div v-if="activeWorkspace" class="flex items-center gap-2">
        <AtomsBaseButton
          size="sm"
          @click="starterDialogOpen = true"
        >
          <template #prepend>
            <span class="icon-[annon--layers] size-4" aria-hidden="true" />
          </template>
          <span>{{ t('starters.use_template') }}</span>
        </AtomsBaseButton>
        <AtomsBaseButton
          size="sm"
          @click="connectDialogOpen = true"
        >
          <template #prepend>
            <span class="icon-[annon--plus] size-4" aria-hidden="true" />
          </template>
          <span>{{ t('projects.connect_repo') }}</span>
        </AtomsBaseButton>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="mt-8 grid gap-4 sm:grid-cols-2">
      <AtomsSkeleton v-for="i in 4" :key="i" variant="card" />
    </div>

    <!-- Project Grid -->
    <div v-else-if="projects.length > 0" class="mt-6 grid gap-4 sm:grid-cols-2">
      <MoleculesProjectCard
        v-for="project in projects"
        :key="project.id"
        :project="project"
        :workspace-slug="slug"
      />
    </div>

    <!-- Empty State: no installation -->
    <AtomsEmptyState
      v-else-if="activeWorkspace && !activeWorkspace.github_installation_id"
      illustration="/illustrations/connect-github.png"
      :title="t('github.install_title')"
      :description="t('github.install_description')"
    >
      <template #action>
        <AtomsBaseButton
          variant="primary"
          size="md"
          @click="connectDialogOpen = true"
        >
          <template #prepend>
            <span class="icon-[annon--external-link] size-4" aria-hidden="true" />
          </template>
          <span>{{ t('github.install_button') }}</span>
        </AtomsBaseButton>
      </template>
    </AtomsEmptyState>

    <!-- Empty State: installed but no projects -->
    <AtomsEmptyState
      v-else
      illustration="/illustrations/empty-projects.png"
      :title="t('projects.empty_title')"
      :description="t('projects.empty_description')"
    >
      <template #action>
        <div v-if="activeWorkspace" class="flex items-center gap-2">
          <AtomsBaseButton
            size="md"
            variant="primary"
            @click="starterDialogOpen = true"
          >
            <template #prepend>
              <span class="icon-[annon--layers] size-4" aria-hidden="true" />
            </template>
            <span>{{ t('starters.use_template') }}</span>
          </AtomsBaseButton>
          <AtomsBaseButton
            size="md"
            @click="connectDialogOpen = true"
          >
            <template #prepend>
              <span class="icon-[annon--plus] size-4" aria-hidden="true" />
            </template>
            <span>{{ t('projects.connect_repo') }}</span>
          </AtomsBaseButton>
        </div>
      </template>
    </AtomsEmptyState>

    <!-- Dialogs -->
    <OrganismsConnectRepoDialog v-model:open="connectDialogOpen" />
    <OrganismsStarterKitDialog v-model:open="starterDialogOpen" />
  </div>
</template>
