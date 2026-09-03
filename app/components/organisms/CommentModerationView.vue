<script setup lang="ts">
import { CheckboxIndicator, CheckboxRoot } from 'radix-vue'
import type { CommentStatus, StudioComment } from '~/composables/useComments'

const props = defineProps<{
  workspaceId: string
  projectId: string
  modelId: string
  editable?: boolean
}>()

const { t } = useContent()
const toast = useToast()

const { comments, total, counts, loading, fetchComments, setStatus, deleteComment, reply, bulk, setThreadClosed } = useComments(
  () => props.workspaceId,
  () => props.projectId,
)

type Filter = 'pending' | 'approved' | 'spam' | 'rejected' | 'all'
const activeFilter = ref<Filter>('pending')
const selected = ref<Set<string>>(new Set())
const detail = ref<StudioComment | null>(null)
const detailOpen = ref(false)

const statusFilters = computed(() => [
  { key: 'pending' as const, label: t('comments.pending'), count: counts.value.pending },
  { key: 'approved' as const, label: t('comments.approved'), count: counts.value.approved },
  { key: 'spam' as const, label: t('comments.spam'), count: counts.value.spam },
  { key: 'rejected' as const, label: t('comments.rejected'), count: counts.value.rejected },
  { key: 'all' as const, label: t('comments.all'), count: null },
])

const statusVariant: Record<CommentStatus, 'warning' | 'success' | 'danger' | 'secondary'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  spam: 'secondary',
}

function statusLabel(status: CommentStatus): string {
  const map: Record<CommentStatus, string> = {
    pending: t('comments.pending'),
    approved: t('comments.approved'),
    rejected: t('comments.rejected'),
    spam: t('comments.spam'),
  }
  return map[status]
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const diffMs = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  const diffHr = Math.floor(diffMs / 3_600_000)
  const diffDay = Math.floor(diffMs / 86_400_000)

  if (diffMin < 60) return t('time.minutes_ago', { count: Math.max(1, diffMin) })
  if (diffHr < 24) return t('time.hours_ago', { count: diffHr })
  if (diffDay < 30) return t('time.days_ago', { count: diffDay })
  return date.toLocaleDateString()
}

function excerpt(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim()
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine
}

async function load() {
  selected.value = new Set()
  await fetchComments({
    modelId: props.modelId,
    status: activeFilter.value === 'all' ? undefined : activeFilter.value,
    limit: 100,
  })
}

watch(activeFilter, load)
watch(() => props.modelId, load)
onMounted(load)

// ── Row actions ──

async function act(fn: () => Promise<unknown>, successKey: string) {
  try {
    await fn()
    toast.success(t(successKey))
  }
  catch {
    toast.error(t('comments.action_failed'))
  }
}

function approve(id: string) {
  return act(() => setStatus(id, 'approved'), 'comments.approved_toast')
}
function reject(id: string) {
  return act(() => setStatus(id, 'rejected'), 'comments.rejected_toast')
}
function markSpam(id: string) {
  return act(() => setStatus(id, 'spam'), 'comments.spam_toast')
}
function restore(id: string) {
  return act(() => setStatus(id, 'pending'), 'comments.restored_toast')
}
async function remove(id: string) {
  await act(() => deleteComment(id), 'comments.deleted_toast')
  if (detail.value?.id === id) detailOpen.value = false
}
async function sendReply(id: string, body: string) {
  await act(() => reply(id, body), 'comments.replied_toast')
}
async function toggleThread(comment: StudioComment, closed: boolean) {
  await act(() => setThreadClosed(comment.model_id, comment.entry_id, closed, comment.locale), closed ? 'comments.thread_closed_toast' : 'comments.thread_opened_toast')
}

// ── Bulk ──

function toggleSelected(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleAll() {
  if (selected.value.size === comments.value.length) {
    selected.value = new Set()
  }
  else {
    selected.value = new Set(comments.value.map(c => c.id))
  }
}

async function bulkAction(action: 'approve' | 'reject' | 'spam' | 'delete') {
  const ids = [...selected.value]
  if (ids.length === 0) return
  await act(() => bulk(action, ids), 'comments.bulk_done')
  selected.value = new Set()
}

function openDetail(comment: StudioComment) {
  detail.value = comment
  detailOpen.value = true
}

// Keep the modal's row in sync with list mutations
watch(comments, (list) => {
  if (!detail.value) return
  const fresh = list.find(c => c.id === detail.value!.id)
  if (fresh) detail.value = fresh
}, { deep: true })
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Filter bar -->
    <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-secondary-200 px-4 py-2.5 dark:border-secondary-800">
      <button
        v-for="filter in statusFilters"
        :key="filter.key"
        type="button"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
        :class="activeFilter === filter.key
          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400'
          : 'text-muted hover:bg-secondary-50 hover:text-body dark:hover:bg-secondary-900 dark:hover:text-secondary-300'
        "
        :aria-pressed="activeFilter === filter.key"
        @click="activeFilter = filter.key"
      >
        {{ filter.label }}
        <span v-if="filter.count !== null && filter.count > 0" class="rounded-full bg-secondary-100 px-1.5 text-[10px] tabular-nums text-body dark:bg-secondary-800 dark:text-secondary-300">
          {{ filter.count }}
        </span>
      </button>
    </div>

    <!-- Bulk bar -->
    <div
      v-if="editable && selected.size > 0"
      class="flex shrink-0 items-center gap-2 border-b border-secondary-200 bg-secondary-50 px-4 py-2 dark:border-secondary-800 dark:bg-secondary-900"
    >
      <span class="text-xs text-body dark:text-secondary-300">{{ t('comments.selected_count', { count: selected.size }) }}</span>
      <div class="ml-auto flex items-center gap-1">
        <AtomsBaseButton type="button" variant="ghost" size="sm" @click="bulkAction('approve')">
          {{ t('comments.approve') }}
        </AtomsBaseButton>
        <AtomsBaseButton type="button" variant="ghost" size="sm" @click="bulkAction('spam')">
          {{ t('comments.mark_spam') }}
        </AtomsBaseButton>
        <AtomsBaseButton type="button" variant="ghost" size="sm" @click="bulkAction('reject')">
          {{ t('comments.reject') }}
        </AtomsBaseButton>
        <AtomsBaseButton type="button" variant="danger" size="sm" @click="bulkAction('delete')">
          {{ t('common.delete') }}
        </AtomsBaseButton>
      </div>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="loading" class="space-y-2 p-4">
        <div v-for="i in 5" :key="i" class="flex items-center gap-3 rounded-lg p-3">
          <div class="min-w-0 flex-1 space-y-2">
            <AtomsSkeleton variant="custom" class="h-4 w-3/4 rounded" />
            <AtomsSkeleton variant="custom" class="h-3 w-1/2 rounded" />
          </div>
          <AtomsSkeleton variant="custom" class="h-5 w-16 rounded-full" />
        </div>
      </div>

      <div v-else-if="comments.length === 0" class="p-5">
        <AtomsEmptyState
          icon="icon-[annon--message-text]"
          :title="t('comments.empty_title')"
          :description="t('comments.empty_description')"
        />
      </div>

      <div v-else class="divide-y divide-secondary-100 dark:divide-secondary-800">
        <div
          v-if="editable"
          class="flex items-center gap-3 px-4 py-1.5"
        >
          <CheckboxRoot
            :checked="selected.size > 0 && selected.size === comments.length"
            :aria-label="t('comments.select_all')"
            class="flex size-4 shrink-0 items-center justify-center rounded border border-secondary-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 data-[state=checked]:border-primary-600 data-[state=checked]:bg-primary-600 dark:border-secondary-600 dark:data-[state=checked]:border-primary-500 dark:data-[state=checked]:bg-primary-500"
            @update:checked="toggleAll"
          >
            <CheckboxIndicator>
              <span class="icon-[annon--check] block size-3 text-white" aria-hidden="true" />
            </CheckboxIndicator>
          </CheckboxRoot>
          <span class="text-xs text-muted">{{ t('comments.select_all') }}</span>
        </div>

        <div
          v-for="comment in comments"
          :key="comment.id"
          class="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900/50"
        >
          <CheckboxRoot
            v-if="editable"
            :checked="selected.has(comment.id)"
            :aria-label="t('comments.select_one')"
            class="mt-1 flex size-4 shrink-0 items-center justify-center rounded border border-secondary-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 data-[state=checked]:border-primary-600 data-[state=checked]:bg-primary-600 dark:border-secondary-600 dark:data-[state=checked]:border-primary-500 dark:data-[state=checked]:bg-primary-500"
            @update:checked="toggleSelected(comment.id)"
          >
            <CheckboxIndicator>
              <span class="icon-[annon--check] block size-3 text-white" aria-hidden="true" />
            </CheckboxIndicator>
          </CheckboxRoot>

          <div
            class="min-w-0 flex-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            role="button"
            tabindex="0"
            @click="openDetail(comment)"
            @keydown.enter="openDetail(comment)"
          >
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-medium text-heading dark:text-secondary-100">
                {{ comment.author_name }}
              </p>
              <AtomsBadge v-if="comment.source === 'studio'" variant="info" size="sm">
                {{ t('comments.moderator') }}
              </AtomsBadge>
              <AtomsBadge v-else-if="comment.source === 'import'" variant="secondary" size="sm">
                {{ t('comments.imported') }}
              </AtomsBadge>
              <span v-if="comment.depth > 0" class="text-xs text-muted">↳ {{ t('comments.reply_badge') }}</span>
            </div>
            <p class="mt-0.5 text-sm text-body dark:text-secondary-300">
              {{ excerpt(comment.body) }}
            </p>
            <p class="mt-1 truncate text-xs text-muted">
              {{ comment.entry_id }} · {{ comment.locale }} · {{ formatTime(comment.created_at) }}
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            <AtomsBadge :variant="statusVariant[comment.status]" size="sm">
              {{ statusLabel(comment.status) }}
            </AtomsBadge>

            <div
              v-if="editable"
              class="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
            >
              <AtomsIconButton
                v-if="comment.status !== 'approved'"
                icon="icon-[annon--check]"
                :label="t('comments.approve')"
                size="sm"
                @click.stop="approve(comment.id)"
              />
              <AtomsIconButton
                v-if="comment.status !== 'spam'"
                icon="icon-[annon--shield-cross]"
                :label="t('comments.mark_spam')"
                size="sm"
                @click.stop="markSpam(comment.id)"
              />
              <AtomsIconButton
                v-if="comment.status !== 'rejected'"
                icon="icon-[annon--cross]"
                :label="t('comments.reject')"
                size="sm"
                @click.stop="reject(comment.id)"
              />
            </div>
          </div>
        </div>
      </div>

      <div v-if="comments.length > 0" class="border-t border-secondary-100 px-4 py-2 dark:border-secondary-800">
        <span class="text-xs text-muted">
          {{ t('comments.count', { count: total }) }}
        </span>
      </div>
    </div>

    <OrganismsCommentDetailModal
      v-model:open="detailOpen"
      :comment="detail"
      :editable="editable"
      @approve="approve"
      @reject="reject"
      @spam="markSpam"
      @restore="restore"
      @delete="remove"
      @reply="sendReply"
      @close-thread="(c) => toggleThread(c, true)"
      @open-thread="(c) => toggleThread(c, false)"
    />
  </div>
</template>
