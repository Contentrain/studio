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
      <div class="flex h-14 shrink-0 items-center border-b border-secondary-200 px-5 dark:border-secondary-800">
        <h3 class="text-sm font-semibold text-heading dark:text-secondary-100">
          Content
        </h3>
      </div>
      <div class="flex-1 overflow-y-auto">
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
          <div
            v-for="model in models"
            :key="model.id"
            class="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900"
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
            <AtomsBadge v-if="model.fields.length > 0" variant="secondary" size="sm">
              {{ model.fields.length }} fields
            </AtomsBadge>
          </div>
        </div>

        <!-- Has .contentrain/ but no models -->
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
            <div class="flex items-center justify-between">
              <span class="text-xs text-muted">Status</span>
              <AtomsBadge :variant="project.status === 'active' ? 'success' : 'warning'" size="sm">
                {{ project.status }}
              </AtomsBadge>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
