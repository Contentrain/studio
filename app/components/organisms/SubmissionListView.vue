<script setup lang="ts">
interface FormSubmission {
  id: string
  model_id: string
  data: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'spam'
  source_ip: string | null
  user_agent: string | null
  referrer: string | null
  locale: string
  approved_at: string | null
  created_at: string
}

const { t } = useContent()

const props = defineProps<{
  workspaceId: string
  projectId: string
  modelId: string
  editable?: boolean
}>()

const emit = defineEmits<{
  select: [submission: FormSubmission]
}>()

// --- State ---
const submissions = ref<FormSubmission[]>([])
const loading = ref(false)
const activeFilter = ref<'all' | 'pending' | 'approved' | 'rejected' | 'spam'>('all')

const statusFilters = computed(() => [
  { key: 'all' as const, label: t('forms.all') },
  { key: 'pending' as const, label: t('forms.pending') },
  { key: 'approved' as const, label: t('forms.approved') },
  { key: 'rejected' as const, label: t('forms.rejected') },
  { key: 'spam' as const, label: t('forms.spam') },
])

const filteredSubmissions = computed(() => {
  if (activeFilter.value === 'all') return submissions.value
  return submissions.value.filter(s => s.status === activeFilter.value)
})

// --- Badge variant mapping ---
const statusVariant: Record<FormSubmission['status'], 'warning' | 'success' | 'danger' | 'secondary'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  spam: 'secondary',
}

function statusLabel(status: FormSubmission['status']): string {
  const map: Record<FormSubmission['status'], string> = {
    pending: t('forms.pending'),
    approved: t('forms.approved'),
    rejected: t('forms.rejected'),
    spam: t('forms.spam'),
  }
  return map[status]
}

// --- Helpers ---
function getTitle(data: Record<string, unknown>): string {
  const values = Object.values(data)
  const first = values.find(v => typeof v === 'string' && v.trim())
  return first ? String(first) : '—'
}

function getSubtitle(data: Record<string, unknown>): string {
  const values = Object.values(data)
  let count = 0
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) {
      count++
      if (count === 2) return String(v)
    }
  }
  return ''
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = Date.now()
  const diffMs = now - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  const diffHr = Math.floor(diffMs / 3_600_000)
  const diffDay = Math.floor(diffMs / 86_400_000)

  if (diffMin < 60) return t('time.minutes_ago', { count: Math.max(1, diffMin) })
  if (diffHr < 24) return t('time.hours_ago', { count: diffHr })
  return t('time.days_ago', { count: diffDay })
}

// --- Fetch ---
async function fetchSubmissions() {
  loading.value = true
  try {
    const result = await $fetch<{ submissions: FormSubmission[], total: number }>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/forms/${props.modelId}/submissions`,
      { params: activeFilter.value !== 'all' ? { status: activeFilter.value } : {} },
    )
    submissions.value = result.submissions
  }
  catch {
    submissions.value = []
  }
  finally {
    loading.value = false
  }
}

// --- Actions ---
async function handleApprove(id: string) {
  try {
    await $fetch(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/forms/${props.modelId}/submissions/${id}`,
      { method: 'PATCH', body: { status: 'approved' } },
    )
    await fetchSubmissions()
  }
  catch { /* fetch error bubbles to Vue error handler */ }
}

async function handleReject(id: string) {
  try {
    await $fetch(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/forms/${props.modelId}/submissions/${id}`,
      { method: 'PATCH', body: { status: 'rejected' } },
    )
    await fetchSubmissions()
  }
  catch { /* fetch error bubbles to Vue error handler */ }
}

onMounted(() => {
  fetchSubmissions()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Filter bar -->
    <div class="flex shrink-0 items-center gap-1 border-b border-secondary-200 px-4 py-2.5 dark:border-secondary-800">
      <button
        v-for="filter in statusFilters"
        :key="filter.key"
        type="button"
        class="rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
        :class="activeFilter === filter.key
          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400'
          : 'text-muted hover:bg-secondary-50 hover:text-body dark:hover:bg-secondary-900 dark:hover:text-secondary-300'
        "
        @click="activeFilter = filter.key"
      >
        {{ filter.label }}
      </button>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      <!-- Loading skeleton -->
      <div v-if="loading" class="space-y-2 p-4">
        <div v-for="i in 5" :key="i" class="flex items-center gap-3 rounded-lg p-3">
          <div class="min-w-0 flex-1 space-y-2">
            <AtomsSkeleton variant="custom" class="h-4 w-3/4 rounded" />
            <AtomsSkeleton variant="custom" class="h-3 w-1/2 rounded" />
          </div>
          <AtomsSkeleton variant="custom" class="h-5 w-16 rounded-full" />
        </div>
      </div>

      <!-- Empty state -->
      <div v-else-if="filteredSubmissions.length === 0" class="p-5">
        <AtomsEmptyState
          icon="icon-[annon--inbox]"
          :title="t('forms.empty_title')"
          :description="t('forms.empty_description')"
        />
      </div>

      <!-- Submission list -->
      <div v-else class="divide-y divide-secondary-100 dark:divide-secondary-800">
        <div
          v-for="submission in filteredSubmissions"
          :key="submission.id"
          class="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900/50"
          role="button"
          tabindex="0"
          @click="emit('select', submission)"
          @keydown.enter="emit('select', submission)"
        >
          <!-- Left: title + subtitle -->
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-heading dark:text-secondary-100">
              {{ getTitle(submission.data) }}
            </p>
            <p v-if="getSubtitle(submission.data)" class="mt-0.5 truncate text-xs text-muted">
              {{ getSubtitle(submission.data) }}
            </p>
          </div>

          <!-- Center: status badge -->
          <AtomsBadge :variant="statusVariant[submission.status]" size="sm">
            {{ statusLabel(submission.status) }}
          </AtomsBadge>

          <!-- Right: timestamp + hover actions -->
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="text-xs text-muted">
              {{ formatTime(submission.created_at) }}
            </span>

            <!-- Hover action buttons (approve/reject) -->
            <div
              v-if="editable && submission.status === 'pending'"
              class="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
            >
              <AtomsIconButton
                icon="icon-[annon--check]"
                :label="t('forms.approve')"
                size="sm"
                @click.stop="handleApprove(submission.id)"
              />
              <AtomsIconButton
                icon="icon-[annon--cross]"
                :label="t('forms.reject')"
                size="sm"
                @click.stop="handleReject(submission.id)"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Footer count -->
      <div v-if="submissions.length > 0" class="border-t border-secondary-100 px-4 py-2 dark:border-secondary-800">
        <span class="text-xs text-muted">
          {{ t('forms.submissions_count', { count: filteredSubmissions.length }) }}
        </span>
      </div>
    </div>
  </div>
</template>
