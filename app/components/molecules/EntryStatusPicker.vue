<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'radix-vue'

/**
 * Status badge + inline picker for a single content entry, shared by the
 * collection and document views so both kinds stay in sync. The parent
 * resolves the current `status` string from its own meta shape (collection:
 * id-keyed map, document: slug-keyed map) and passes it in; this component
 * owns the PATCH to `/content/{modelId}/status` and the owner/admin gate.
 */
const props = defineProps<{
  status: string | null
  entryId: string
  workspaceId?: string
  projectId?: string
  modelId?: string
  locale?: string
  editable?: boolean
}>()

const emit = defineEmits<{
  saved: []
}>()

const { t } = useContent()
const toast = useToast()
const { isOwnerOrAdmin } = useWorkspaceRole()

// Statuses an Owner/Admin can set directly from the badge menu. Review-workflow
// states (in_review/rejected) are produced by the review flow, not set here.
const SETTABLE_STATUSES = ['draft', 'published', 'archived'] as const

const statusVariants: Record<string, { variant: 'success' | 'warning' | 'primary' | 'secondary' | 'danger', label: string }> = {
  published: { variant: 'success', label: 'published' },
  draft: { variant: 'warning', label: 'draft' },
  in_review: { variant: 'primary', label: 'review' },
  rejected: { variant: 'danger', label: 'rejected' },
  archived: { variant: 'secondary', label: 'archived' },
}

const saving = ref(false)

const canEdit = computed(() => Boolean(props.status && isOwnerOrAdmin.value && props.editable))

async function setStatus(newStatus: string) {
  if (!props.workspaceId || !props.projectId || !props.modelId) return
  if (saving.value || props.status === newStatus) return

  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/content/${props.modelId}/status`, {
      method: 'PATCH',
      body: { entryIds: [props.entryId], status: newStatus, locale: props.locale ?? 'en' },
    })
    toast.success(t('content.status_updated'))
    emit('saved')
  }
  catch (e: unknown) {
    toast.error(resolveApiError(e, t('content.status_error')))
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- Status picker (owner/admin) — click badge to change status -->
  <DropdownMenuRoot v-if="canEdit">
    <DropdownMenuTrigger as-child>
      <button
        type="button" :disabled="saving"
        class="shrink-0 rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-wait"
        :title="t('content.change_status')" :aria-label="t('content.change_status')"
      >
        <AtomsBadge :variant="statusVariants[status!]?.variant ?? 'secondary'" size="sm" class="gap-1">
          {{ statusVariants[status!]?.label ?? status }}
          <span v-if="saving" class="icon-[annon--loader] size-2.5 animate-spin" aria-hidden="true" />
          <span v-else class="icon-[annon--chevron-down] size-2.5 opacity-60" aria-hidden="true" />
        </AtomsBadge>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        align="end" :side-offset="4"
        class="z-50 min-w-36 rounded-lg border border-secondary-200 bg-white p-1 shadow-lg dark:border-secondary-800 dark:bg-secondary-950"
      >
        <DropdownMenuItem
          v-for="s in SETTABLE_STATUSES" :key="s"
          :disabled="saving"
          class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm text-heading outline-none transition-colors data-highlighted:bg-secondary-50 data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:text-secondary-100 dark:data-highlighted:bg-secondary-900"
          @select="setStatus(s)"
        >
          {{ t(`content.status_${s}`) }}
          <span v-if="status === s" class="icon-[annon--check] size-3.5 text-primary-500" aria-hidden="true" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
  <!-- Read-only badge (no edit rights) -->
  <AtomsBadge
    v-else-if="status"
    :variant="statusVariants[status]?.variant ?? 'secondary'" size="sm"
    class="shrink-0"
  >
    {{ statusVariants[status]?.label ?? status }}
  </AtomsBadge>
</template>
