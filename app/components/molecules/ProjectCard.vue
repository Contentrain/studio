<script setup lang="ts">
const props = defineProps<{
  project: {
    id: string
    repo_full_name: string
    detected_stack: string | null
    status: string
    created_at: string
  }
  workspaceSlug: string
}>()

const { t } = useContent()

const timeAgo = computed(() => {
  const diff = Date.now() - new Date(props.project.created_at).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return t('time.minutes_ago').replace('{count}', String(minutes))
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hours_ago').replace('{count}', String(hours))
  const days = Math.floor(hours / 24)
  return t('time.days_ago').replace('{count}', String(days))
})

const stackLabel = computed(() => {
  const s = props.project.detected_stack
  if (!s) return null
  return s.charAt(0).toUpperCase() + s.slice(1)
})

const repoUrl = computed(() => {
  // Provider-agnostic: detect from repo_full_name format
  // GitHub: "owner/repo", GitLab/Bitbucket will have different patterns in the future
  return `https://github.com/${props.project.repo_full_name}`
})
</script>

<template>
  <NuxtLink
    :to="`/w/${workspaceSlug}/projects/${project.id}`"
    class="group flex flex-col rounded-xl border border-secondary-200 bg-white p-5 transition-all hover:border-primary-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-800 dark:bg-secondary-950 dark:hover:border-primary-700"
  >
    <!-- Header -->
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <AtomsHeadingText :level="3" size="xs" truncate>
          {{ project.repo_full_name.split('/').pop() }}
        </AtomsHeadingText>
        <div class="mt-1 flex items-center gap-2">
          <AtomsBadge v-if="stackLabel" variant="primary" size="sm">
            {{ stackLabel }}
          </AtomsBadge>
          <AtomsBadge
            :variant="project.status === 'active' ? 'success' : project.status === 'setup' ? 'warning' : 'danger'"
            size="sm"
          >
            {{ project.status }}
          </AtomsBadge>
        </div>
      </div>
      <span
        class="icon-[annon--arrow-right] size-4 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
    </div>

    <!-- Footer -->
    <div class="mt-4 flex items-center justify-between text-xs text-muted">
      <span>{{ timeAgo }}</span>
      <a
        :href="repoUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="rounded p-1 text-muted transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
        :title="project.repo_full_name"
        @click.stop
      >
        <!-- GitHub logo (brand SVG — exact colors per CLAUDE.md rules) -->
        <svg class="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
      </a>
    </div>
  </NuxtLink>
</template>
