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
          {{ project.repo_full_name }}
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
    </div>
  </NuxtLink>
</template>
