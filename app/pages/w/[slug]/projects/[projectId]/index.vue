<script setup lang="ts">
definePageMeta({
  layout: 'default',
})

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const projectId = computed(() => route.params.projectId as string)

const { workspaces, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const { projects, fetchProjects } = useProjects()
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
  }
})
</script>

<template>
  <div class="flex h-full">
    <!-- Chat panel placeholder -->
    <div class="flex flex-1 flex-col border-r border-secondary-200 dark:border-secondary-800">
      <div class="flex h-14 shrink-0 items-center border-b border-secondary-200 px-6 dark:border-secondary-800">
        <h2 class="text-sm font-semibold text-heading dark:text-secondary-100">
          {{ project?.repo_full_name ?? t('common.loading') }}
        </h2>
      </div>
      <div class="flex flex-1 items-center justify-center">
        <div class="text-center">
          <span class="icon-[annon--comment-2-plus] text-4xl text-muted" aria-hidden="true" />
          <p class="mt-3 text-sm text-muted">
            Chat will be available in Phase 2.
          </p>
        </div>
      </div>
    </div>

    <!-- Context panel -->
    <div class="hidden w-80 min-w-0 shrink-0 border-l border-secondary-200 lg:flex lg:flex-col xl:w-96 dark:border-secondary-800">
      <div class="flex h-14 shrink-0 items-center px-5">
        <h3 class="text-sm font-semibold text-heading dark:text-secondary-100">
          Overview
        </h3>
      </div>
      <div class="flex-1 overflow-y-auto px-5 pb-6">
        <template v-if="project">
          <div class="space-y-5">
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Repository
              </div>
              <p class="mt-1 truncate text-sm text-heading dark:text-secondary-100">
                {{ project.repo_full_name }}
              </p>
            </div>
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Stack
              </div>
              <p class="mt-1 text-sm text-heading dark:text-secondary-100">
                {{ project.detected_stack ?? t('projects.unknown_stack') }}
              </p>
            </div>
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Branch
              </div>
              <p class="mt-1 text-sm text-heading dark:text-secondary-100">
                {{ project.default_branch }}
              </p>
            </div>
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Status
              </div>
              <AtomsBadge
                :variant="project.status === 'active' ? 'success' : 'warning'"
                size="md"
                class="mt-1"
              >
                {{ project.status }}
              </AtomsBadge>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
