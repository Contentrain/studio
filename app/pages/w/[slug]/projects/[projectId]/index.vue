<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug as string)
const projectId = computed(() => route.params.projectId as string)

const { workspaces, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { projects, fetchProjects } = useProjects()
const { snapshot, loading: snapshotLoading, fetchSnapshot } = useSnapshot()
const { t } = useContent()

const project = computed(() =>
  projects.value.find(p => p.id === projectId.value) ?? null,
)

// Content panel state via URL query param
const activeModelId = computed(() => route.query.model as string ?? null)
const modelContent = ref<unknown>(null)
const modelContentKind = ref<string>('collection')
const modelContentLoading = ref(false)

onMounted(async () => {
  if (workspaces.value.length === 0)
    await fetchWorkspaces()

  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (ws) {
    setActiveWorkspace(ws.id)
    if (projects.value.length === 0)
      await fetchProjects(ws.id)
    await fetchSnapshot(ws.id, projectId.value)
  }
})

watch(activeModelId, async (modelId) => {
  if (!modelId) {
    modelContent.value = null
    return
  }
  modelContentLoading.value = true
  modelContent.value = null
  const ws = workspaces.value.find(w => w.slug === slug.value)
  if (!ws) return
  try {
    const result = await $fetch<{ data: unknown, kind?: string }>(`/api/workspaces/${ws.id}/projects/${projectId.value}/content/${modelId}`)
    modelContent.value = result.data
    modelContentKind.value = result.kind ?? 'collection'
  }
  catch { modelContent.value = null }
  finally { modelContentLoading.value = false }
}, { immediate: true })

function selectModel(modelId: string) {
  router.replace({ query: { ...route.query, model: modelId } })
}

function backToOverview() {
  const query = { ...route.query }
  delete query.model
  router.replace({ query })
}
</script>

<template>
  <div class="flex h-full">
    <!-- Chat panel -->
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex h-14 shrink-0 items-center border-b border-secondary-200 px-6 dark:border-secondary-800">
        <h2 class="truncate text-sm font-semibold text-heading dark:text-secondary-100">
          {{ project?.repo_full_name ?? t('common.loading') }}
        </h2>
      </div>
      <div class="flex flex-1 items-center justify-center">
        <AtomsEmptyState icon="icon-[annon--comment-2-plus]" title="Chat" description="Conversation-first content management. Coming in Phase 2." />
      </div>
    </div>

    <!-- Context panel -->
    <div class="hidden w-80 min-w-0 shrink-0 border-l border-secondary-200 lg:flex lg:flex-col xl:w-96 dark:border-secondary-800">
      <OrganismsContentPanel
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
