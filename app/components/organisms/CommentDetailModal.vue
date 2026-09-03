<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'
import type { CommentStatus, StudioComment } from '~/composables/useComments'

const { t } = useContent()

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  comment: StudioComment | null
  editable?: boolean
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
  spam: [id: string]
  restore: [id: string]
  delete: [id: string]
  reply: [id: string, body: string]
  closeThread: [comment: StudioComment]
  openThread: [comment: StudioComment]
}>()

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

function formatDate(dateStr: string | null): string {
  return dateStr ? new Date(dateStr).toLocaleString() : '—'
}

const replyText = ref('')
const replying = ref(false)

watch(() => props.comment?.id, () => {
  replyText.value = ''
})

async function submitReply() {
  const body = replyText.value.trim()
  if (!body || !props.comment) return
  replying.value = true
  try {
    emit('reply', props.comment.id, body)
    replyText.value = ''
  }
  finally {
    replying.value = false
  }
}

const confirmingDelete = ref(false)
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
      />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 flex w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center justify-between border-b border-secondary-200 px-5 py-4 dark:border-secondary-800">
          <div class="flex items-center gap-2.5">
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('comments.detail_title') }}
            </DialogTitle>
            <AtomsBadge v-if="comment" :variant="statusVariant[comment.status]" size="sm">
              {{ statusLabel(comment.status) }}
            </AtomsBadge>
          </div>
          <DialogClose
            class="rounded-md p-1 text-muted transition-colors hover:bg-secondary-100 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
            <span class="sr-only">{{ t('common.close') }}</span>
          </DialogClose>
        </div>
        <DialogDescription class="sr-only">
          {{ t('comments.detail_title') }}
        </DialogDescription>

        <!-- Body -->
        <div v-if="comment" class="max-h-[60vh] overflow-y-auto px-5 py-4">
          <!-- Comment -->
          <div class="rounded-lg border border-secondary-200 bg-secondary-50 p-3 dark:border-secondary-800 dark:bg-secondary-900">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-heading dark:text-secondary-100">{{ comment.author_name }}</span>
              <AtomsBadge v-if="comment.source === 'studio'" variant="info" size="sm">
                {{ t('comments.moderator') }}
              </AtomsBadge>
              <AtomsBadge v-else-if="comment.source === 'import'" variant="secondary" size="sm">
                {{ t('comments.imported') }}
              </AtomsBadge>
              <AtomsBadge v-if="comment.type !== 'comment'" variant="secondary" size="sm">
                {{ comment.type }}
              </AtomsBadge>
              <span class="ml-auto text-xs text-muted">{{ formatDate(comment.created_at) }}</span>
            </div>
            <p class="mt-2 whitespace-pre-wrap wrap-break-word text-sm text-body dark:text-secondary-300">
              {{ comment.body }}
            </p>
          </div>

          <!-- Metadata -->
          <div class="mt-5">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {{ t('comments.metadata') }}
            </h3>
            <dl class="divide-y divide-secondary-100 dark:divide-secondary-800">
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('comments.entry') }}
                </dt>
                <dd class="min-w-0 flex-1 wrap-break-word text-sm text-body dark:text-secondary-300">
                  {{ comment.model_id }} / {{ comment.entry_id }} · {{ comment.locale }}
                </dd>
              </div>
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('comments.email') }}
                </dt>
                <dd class="min-w-0 flex-1 wrap-break-word text-sm text-body dark:text-secondary-300">
                  {{ comment.author_email ?? '—' }}
                </dd>
              </div>
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('comments.website') }}
                </dt>
                <dd class="min-w-0 flex-1 wrap-break-word text-sm text-body dark:text-secondary-300">
                  {{ comment.author_url ?? '—' }}
                </dd>
              </div>
              <div v-if="comment.parent_id" class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('comments.in_reply_to') }}
                </dt>
                <dd class="min-w-0 flex-1 truncate font-mono text-xs text-body dark:text-secondary-300">
                  {{ comment.parent_id }}
                </dd>
              </div>
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('comments.source_ip') }}
                </dt>
                <dd class="min-w-0 flex-1 text-sm text-body dark:text-secondary-300">
                  {{ comment.source_ip ?? '—' }}
                </dd>
              </div>
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('comments.moderated_at') }}
                </dt>
                <dd class="min-w-0 flex-1 text-sm text-body dark:text-secondary-300">
                  {{ formatDate(comment.moderated_at) }}
                </dd>
              </div>
            </dl>
          </div>

          <!-- Reply -->
          <div v-if="editable" class="mt-5 border-t border-secondary-100 pt-5 dark:border-secondary-800">
            <AtomsFormLabel for="comment-reply">
              {{ t('comments.reply_label') }}
            </AtomsFormLabel>
            <p class="mb-1.5 text-xs text-muted">
              {{ t('comments.reply_description') }}
            </p>
            <AtomsFormTextarea
              id="comment-reply"
              :model-value="replyText"
              :rows="3"
              :placeholder="t('comments.reply_placeholder')"
              @update:model-value="replyText = $event"
            />
            <div class="mt-2 flex items-center justify-between">
              <button
                type="button"
                class="rounded text-xs font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400"
                @click="emit('closeThread', comment)"
              >
                {{ t('comments.close_thread') }}
              </button>
              <button
                type="button"
                class="rounded text-xs font-medium text-muted hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                @click="emit('openThread', comment)"
              >
                {{ t('comments.open_thread') }}
              </button>
              <AtomsBaseButton type="button" variant="primary" size="sm" :disabled="!replyText.trim() || replying" @click="submitReply">
                {{ t('comments.send_reply') }}
              </AtomsBaseButton>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div
          v-if="comment && editable"
          class="flex shrink-0 items-center justify-between border-t border-secondary-200 px-5 py-3 dark:border-secondary-800"
        >
          <div class="flex items-center gap-2">
            <AtomsBaseButton v-if="!confirmingDelete" type="button" variant="danger" size="sm" @click="confirmingDelete = true">
              <template #prepend>
                <span class="icon-[annon--trash] size-3.5" aria-hidden="true" />
              </template>
              {{ t('common.delete') }}
            </AtomsBaseButton>
            <template v-else>
              <span class="text-xs text-danger-600 dark:text-danger-400">{{ t('comments.delete_confirm') }}</span>
              <AtomsBaseButton type="button" variant="danger" size="sm" @click="emit('delete', comment.id); confirmingDelete = false">
                {{ t('common.delete') }}
              </AtomsBaseButton>
              <AtomsBaseButton type="button" variant="ghost" size="sm" @click="confirmingDelete = false">
                {{ t('common.cancel') }}
              </AtomsBaseButton>
            </template>
          </div>
          <div class="flex items-center gap-2">
            <AtomsBaseButton v-if="comment.status !== 'spam'" type="button" variant="ghost" size="sm" @click="emit('spam', comment.id)">
              {{ t('comments.mark_spam') }}
            </AtomsBaseButton>
            <AtomsBaseButton v-if="comment.status !== 'rejected'" type="button" variant="ghost" size="sm" @click="emit('reject', comment.id)">
              {{ t('comments.reject') }}
            </AtomsBaseButton>
            <AtomsBaseButton v-if="comment.status !== 'pending' && comment.status !== 'approved'" type="button" variant="ghost" size="sm" @click="emit('restore', comment.id)">
              {{ t('comments.restore') }}
            </AtomsBaseButton>
            <AtomsBaseButton v-if="comment.status !== 'approved'" type="button" variant="primary" size="sm" @click="emit('approve', comment.id)">
              {{ t('comments.approve') }}
            </AtomsBaseButton>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
