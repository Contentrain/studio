<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)
const projectId = computed(() => route.params.projectId as string)

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { projects, fetchProjects } = useProjects()
const { snapshot, loading: snapshotLoading, fetchSnapshot } = useSnapshot()
const { content: modelContent, kind: modelContentKind, loading: modelContentLoading, fetchContent, clearContent } = useModelContent()
const { t } = useContent()

const project = computed(() =>
  projects.value.find(p => p.id === projectId.value) ?? null,
)

const activeModelId = computed(() => route.query.model as string ?? null)
const activeLocale = ref('en')

onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
    if (projects.value.length === 0)
      await fetchProjects(ws.id)
    await fetchSnapshot(ws.id, projectId.value)

    // Set default locale from config
    const config = snapshot.value?.config as { locales?: { default?: string } } | null
    if (config?.locales?.default) activeLocale.value = config.locales.default

    if (activeModelId.value) {
      await fetchContent(ws.id, projectId.value, activeModelId.value, activeLocale.value)
    }
  }
})

// Watch for model changes AFTER initial load (user clicks in sidebar)
watch(activeModelId, async (modelId, oldModelId) => {
  // Skip initial — handled by onMounted above
  if (oldModelId === undefined) return
  if (!modelId) {
    clearContent()
    return
  }
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return
  await fetchContent(ws.id, projectId.value, modelId, activeLocale.value)
})

// Locale change — re-fetch current model content
watch(activeLocale, async (locale) => {
  if (!activeModelId.value) return
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return
  await fetchContent(ws.id, projectId.value, activeModelId.value, locale)
})

function selectModel(modelId: string) {
  router.replace({ query: { ...route.query, model: modelId } })
}

function backToOverview() {
  const query = { ...route.query }
  delete query.model
  router.replace({ query })
}

async function handleContentChanged() {
  const { invalidateCache } = useSnapshot()
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return
  await invalidateCache(projectId.value)
  await fetchSnapshot(ws.id, projectId.value)
  if (activeModelId.value) {
    await fetchContent(ws.id, projectId.value, activeModelId.value, activeLocale.value)
  }
}
</script>

<template>
  <div class="flex h-full">
    <!-- Chat panel -->
    <div class="flex min-w-0 flex-1 flex-col">
      <OrganismsChatPanel
        v-if="activeWorkspace"
        :workspace-id="activeWorkspace.id"
        :project-id="projectId"
        :project-name="project?.repo_full_name ?? t('common.loading')"
        @content-changed="handleContentChanged"
      />
    </div>

    <!-- Context panel -->
    <div class="hidden w-80 min-w-0 shrink-0 border-l border-secondary-200 lg:flex lg:flex-col xl:w-96 dark:border-secondary-800">
      <OrganismsContentPanel
        v-model:locale="activeLocale"
        :snapshot="(snapshot as any)"
        :snapshot-loading="snapshotLoading"
        :model-content="modelContent"
        :model-content-kind="modelContentKind"
        :model-content-loading="modelContentLoading"
        :active-model-id="activeModelId"
        @select-model="selectModel"
        @back="backToOverview"
      />
    </div>
  </div>
</template>
