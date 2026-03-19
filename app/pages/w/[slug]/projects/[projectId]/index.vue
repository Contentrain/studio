<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const projectId = computed(() => route.params.projectId as string)

const { workspaces, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { projects, fetchProjects } = useProjects()
const { snapshot, models, hasContentrain, loading: snapshotLoading, fetchSnapshot } = useSnapshot()
const { t } = useContent()

const project = computed(() =>
  projects.value.find(p => p.id === projectId.value) ?? null,
)

// Context panel state via query param (survives refresh, shareable)
const router = useRouter()
const activeModelId = computed(() => route.query.model as string | undefined ?? null)
const panelState = computed(() => activeModelId.value ? 'model' : 'overview')
const modelContent = ref<unknown>(null)
const modelContentLoading = ref(false)

const activeModel = computed(() =>
  models.value.find(m => m.id === activeModelId.value) ?? null,
)

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

// Load model content when activeModelId changes
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
    const result = await $fetch<{ data: unknown }>(`/api/workspaces/${ws.id}/projects/${projectId.value}/content/${modelId}`)
    modelContent.value = result.data
  }
  catch {
    modelContent.value = null
  }
  finally {
    modelContentLoading.value = false
  }
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
    <!-- Chat panel placeholder -->
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex h-14 shrink-0 items-center border-b border-secondary-200 px-6 dark:border-secondary-800">
        <h2 class="truncate text-sm font-semibold text-heading dark:text-secondary-100">
          {{ project?.repo_full_name ?? t('common.loading') }}
        </h2>
      </div>
      <div class="flex flex-1 items-center justify-center">
        <AtomsEmptyState
          icon="icon-[annon--comment-2-plus]"
          title="Chat"
          description="Conversation-first content management. Coming in Phase 2."
        />
      </div>
    </div>

    <!-- Context panel -->
    <div class="hidden w-80 min-w-0 shrink-0 border-l border-secondary-200 lg:flex lg:flex-col xl:w-96 dark:border-secondary-800">
      <!-- Panel header -->
      <div class="flex h-14 shrink-0 items-center gap-2 border-b border-secondary-200 px-5 dark:border-secondary-800">
        <button
          v-if="panelState === 'model'"
          type="button"
          class="rounded p-1 text-muted transition-colors hover:bg-secondary-50 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900 dark:hover:text-secondary-100"
          @click="backToOverview"
        >
          <span class="icon-[annon--arrow-left] block size-4" aria-hidden="true" />
        </button>
        <h3 class="truncate text-sm font-semibold text-heading dark:text-secondary-100">
          {{ panelState === 'model' && activeModel ? activeModel.name : 'Content' }}
        </h3>
        <AtomsBadge v-if="panelState === 'model' && activeModel" variant="secondary" size="sm" class="ml-auto shrink-0">
          {{ activeModel.type }}
        </AtomsBadge>
      </div>

      <div class="flex-1 overflow-y-auto">
        <!-- OVERVIEW STATE -->
        <template v-if="panelState === 'overview'">
          <!-- Loading -->
          <div v-if="snapshotLoading" class="space-y-2 p-5">
            <AtomsSkeleton v-for="i in 4" :key="i" variant="custom" class="h-10 w-full rounded-lg" />
          </div>

          <!-- No .contentrain/ -->
          <div v-else-if="!hasContentrain" class="p-5">
            <AtomsEmptyState
              icon="icon-[annon--folder-open]"
              title=".contentrain/ not found"
              description="Initialize content structure via chat in Phase 2."
            />
          </div>

          <!-- Models list -->
          <div v-else-if="models.length > 0" class="py-2">
            <button
              v-for="model in models"
              :key="model.id"
              type="button"
              class="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
              @click="selectModel(model.id)"
            >
              <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary-100 dark:bg-secondary-800">
                <span
                  :class="model.type === 'singleton' ? 'icon-[annon--file]' : 'icon-[annon--list-unordered]'"
                  class="size-4 text-muted"
                  aria-hidden="true"
                />
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
                  {{ model.name }}
                </div>
                <div class="flex items-center gap-2 text-xs text-muted">
                  <span>{{ model.type }}</span>
                  <span v-if="snapshot?.content?.[model.id]">
                    · {{ snapshot.content[model.id].locales.length }} {{ snapshot.content[model.id].locales.length === 1 ? 'locale' : 'locales' }}
                  </span>
                </div>
              </div>
              <span class="icon-[annon--chevron-right] size-4 shrink-0 text-muted" aria-hidden="true" />
            </button>
          </div>

          <!-- No models -->
          <div v-else class="p-5">
            <AtomsEmptyState
              icon="icon-[annon--box]"
              title="No models yet"
              description="Create models via chat in Phase 2."
            />
          </div>

          <!-- Project info footer -->
          <div v-if="project" class="border-t border-secondary-200 px-5 py-4 dark:border-secondary-800">
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted">Stack</span>
                <AtomsBadge variant="primary" size="sm">
                  {{ project.detected_stack ?? t('projects.unknown_stack') }}
                </AtomsBadge>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted">Branch</span>
                <span class="text-xs font-medium text-heading dark:text-secondary-100">{{ project.default_branch }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- MODEL CONTENT STATE -->
        <template v-else-if="panelState === 'model'">
          <!-- Loading -->
          <div v-if="modelContentLoading" class="space-y-2 p-5">
            <AtomsSkeleton v-for="i in 6" :key="i" variant="line" />
          </div>

          <!-- No content -->
          <div v-else-if="!modelContent" class="p-5">
            <AtomsEmptyState
              icon="icon-[annon--file]"
              title="No content"
              description="This model has no content entries yet."
            />
          </div>

          <!-- Content entries -->
          <div v-else class="p-5">
            <!-- Array content (collection) -->
            <template v-if="Array.isArray(modelContent)">
              <div class="space-y-2">
                <div
                  v-for="(entry, idx) in modelContent"
                  :key="idx"
                  class="rounded-lg border border-secondary-200 p-3 dark:border-secondary-800"
                >
                  <div v-for="(value, key) in (entry as Record<string, unknown>)" :key="String(key)" class="flex items-start gap-2 py-1">
                    <span class="shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted">
                      {{ String(key) }}
                    </span>
                    <span class="ml-auto text-right text-sm text-heading dark:text-secondary-100">
                      {{ typeof value === 'object' ? JSON.stringify(value) : String(value) }}
                    </span>
                  </div>
                </div>
              </div>
              <p class="mt-3 text-xs text-muted">
                {{ (modelContent as unknown[]).length }} entries
              </p>
            </template>

            <!-- Object content (singleton) -->
            <template v-else-if="typeof modelContent === 'object' && modelContent !== null">
              <div class="space-y-3">
                <div v-for="(value, key) in (modelContent as Record<string, unknown>)" :key="String(key)">
                  <div class="text-[11px] font-medium uppercase tracking-wider text-muted">
                    {{ String(key) }}
                  </div>
                  <p class="mt-0.5 break-words text-sm text-heading dark:text-secondary-100">
                    {{ typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value) }}
                  </p>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
