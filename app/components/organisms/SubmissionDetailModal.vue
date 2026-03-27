<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'

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

const open = defineModel<boolean>('open', { default: false })

defineProps<{
  submission: FormSubmission | null
  editable?: boolean
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
  delete: [id: string]
}>()

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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value || '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}
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
        <div
          class="flex shrink-0 items-center justify-between border-b border-secondary-200 px-5 py-4 dark:border-secondary-800"
        >
          <div class="flex items-center gap-2.5">
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('forms.submission_detail') }}
            </DialogTitle>
            <AtomsBadge v-if="submission" :variant="statusVariant[submission.status]" size="sm">
              {{ statusLabel(submission.status) }}
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
          {{ t('forms.submission_detail') }}
        </DialogDescription>

        <!-- Body -->
        <div v-if="submission" class="max-h-[60vh] overflow-y-auto px-5 py-4">
          <!-- Data fields -->
          <div>
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {{ t('forms.data') }}
            </h3>
            <dl class="divide-y divide-secondary-100 dark:divide-secondary-800">
              <div v-for="(value, key) in submission.data" :key="String(key)" class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ String(key) }}
                </dt>
                <dd class="min-w-0 flex-1 wrap-break-word text-sm text-body dark:text-secondary-300">
                  {{ formatValue(value) }}
                </dd>
              </div>
            </dl>
          </div>

          <!-- Metadata -->
          <div class="mt-5 border-t border-secondary-100 pt-5 dark:border-secondary-800">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {{ t('forms.metadata') }}
            </h3>
            <dl class="divide-y divide-secondary-100 dark:divide-secondary-800">
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('forms.source_ip') }}
                </dt>
                <dd class="min-w-0 flex-1 text-sm text-body dark:text-secondary-300">
                  {{ submission.source_ip ?? '—' }}
                </dd>
              </div>
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('forms.user_agent') }}
                </dt>
                <dd class="min-w-0 flex-1 wrap-break-word text-sm text-body dark:text-secondary-300">
                  {{ submission.user_agent ?? '—' }}
                </dd>
              </div>
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('forms.referrer') }}
                </dt>
                <dd class="min-w-0 flex-1 wrap-break-word text-sm text-body dark:text-secondary-300">
                  {{ submission.referrer ?? '—' }}
                </dd>
              </div>
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('forms.locale') }}
                </dt>
                <dd class="min-w-0 flex-1 text-sm text-body dark:text-secondary-300">
                  {{ submission.locale }}
                </dd>
              </div>
              <div class="flex items-start gap-3 py-2.5">
                <dt class="w-32 shrink-0 text-sm font-medium text-label">
                  {{ t('forms.created_at') }}
                </dt>
                <dd class="min-w-0 flex-1 text-sm text-body dark:text-secondary-300">
                  {{ formatDate(submission.created_at) }}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <!-- Footer -->
        <div
          v-if="submission && editable && submission.status === 'pending'"
          class="flex shrink-0 items-center justify-between border-t border-secondary-200 px-5 py-3 dark:border-secondary-800"
        >
          <AtomsBaseButton type="button" variant="danger" size="sm" @click="emit('delete', submission.id)">
            <template #prepend>
              <span class="icon-[annon--trash] size-3.5" aria-hidden="true" />
            </template>
            {{ t('common.delete') }}
          </AtomsBaseButton>
          <div class="flex items-center gap-2">
            <AtomsBaseButton type="button" variant="ghost" size="sm" @click="emit('reject', submission.id)">
              {{ t('forms.reject') }}
            </AtomsBaseButton>
            <AtomsBaseButton type="button" variant="primary" size="sm" @click="emit('approve', submission.id)">
              {{ t('forms.approve') }}
            </AtomsBaseButton>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
