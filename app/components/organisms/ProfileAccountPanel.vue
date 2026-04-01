<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'radix-vue'

interface BlockingWorkspace {
  id: string
  name: string
  slug: string
  workspace_members: Array<{
    id: string
    role: string
    user_id: string
    profiles: { id: string, display_name: string | null, email: string, avatar_url: string | null } | null
  }>
}

const { state: authState, deleteAccount } = useAuth()
const { transferOwnership } = useWorkspaces()
const { t } = useContent()
const toast = useToast()

const blockingWorkspaces = ref<BlockingWorkspace[]>([])
const loadingBlocking = ref(true)
const deleteConfirmOpen = ref(false)
const deleting = ref(false)
const transferring = ref<string | null>(null)
const transferDialogOpen = ref(false)
const transferTarget = ref<{ workspaceId: string, workspaceName: string } | null>(null)
const selectedMemberId = ref<string | null>(null)

const canDelete = computed(() => blockingWorkspaces.value.length === 0 && !loadingBlocking.value)

async function fetchBlockingWorkspaces() {
  loadingBlocking.value = true
  try {
    blockingWorkspaces.value = await $fetch<BlockingWorkspace[]>('/api/profile/owned-workspaces')
  }
  catch {
    blockingWorkspaces.value = []
  }
  finally {
    loadingBlocking.value = false
  }
}

onMounted(fetchBlockingWorkspaces)

function getAdminMembers(ws: BlockingWorkspace) {
  return ws.workspace_members.filter(
    m => m.role === 'admin' && m.user_id !== authState.value.user?.id,
  )
}

function openTransferDialog(ws: BlockingWorkspace) {
  transferTarget.value = { workspaceId: ws.id, workspaceName: ws.name }
  selectedMemberId.value = null
  transferDialogOpen.value = true
}

async function handleTransfer() {
  if (!transferTarget.value || !selectedMemberId.value) return
  transferring.value = transferTarget.value.workspaceId
  try {
    const ok = await transferOwnership(transferTarget.value.workspaceId, selectedMemberId.value)
    if (ok) {
      toast.success(t('account_settings.transfer_success'))
      transferDialogOpen.value = false
      await fetchBlockingWorkspaces()
    }
    else {
      toast.error(t('account_settings.transfer_error'))
    }
  }
  finally {
    transferring.value = null
  }
}

async function handleDeleteAccount() {
  deleting.value = true
  try {
    await deleteAccount()
  }
  catch {
    toast.error(t('account_settings.delete_error'))
    deleting.value = false
  }
}
</script>

<template>
  <div class="max-w-md border-t border-danger-200 pt-5 dark:border-danger-500/20">
    <AtomsHeadingText :level="3" size="xs" class="text-danger-600 dark:text-danger-400">
      {{ t('danger_zone.title') }}
    </AtomsHeadingText>

    <!-- Blocking workspaces that need ownership transfer -->
    <div v-if="blockingWorkspaces.length > 0" class="mt-3 space-y-3">
      <div class="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 dark:border-warning-500/20 dark:bg-warning-500/10">
        <p class="text-sm text-warning-700 dark:text-warning-400">
          {{ t('account_settings.transfer_required_notice') }}
        </p>
      </div>

      <div
        v-for="ws in blockingWorkspaces"
        :key="ws.id"
        class="flex items-center justify-between rounded-lg border border-secondary-200 px-4 py-3 dark:border-secondary-800"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-heading dark:text-secondary-100">
            {{ ws.name }}
          </p>
          <p class="mt-0.5 text-xs text-muted">
            {{ t('account_settings.transfer_members_count', { count: ws.workspace_members.length - 1 }) }}
          </p>
        </div>
        <AtomsBaseButton
          v-if="getAdminMembers(ws).length > 0"
          size="sm"
          variant="primary"
          :disabled="transferring === ws.id"
          class="ml-3 shrink-0"
          @click="openTransferDialog(ws)"
        >
          {{ t('account_settings.transfer_ownership_button') }}
        </AtomsBaseButton>
        <AtomsBadge
          v-else
          variant="warning"
          size="sm"
          class="ml-3 shrink-0"
        >
          {{ t('account_settings.no_admins_to_transfer') }}
        </AtomsBadge>
      </div>
    </div>

    <!-- Delete account section -->
    <div class="mt-3 rounded-lg border border-danger-200 px-4 py-3 dark:border-danger-500/20">
      <div class="flex items-center justify-between">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-heading dark:text-secondary-100">
            {{ t('account_settings.delete_title') }}
          </p>
          <p class="mt-0.5 text-xs text-muted">
            {{ t('account_settings.delete_description') }}
          </p>
        </div>
        <AtomsBaseButton
          variant="danger"
          size="sm"
          class="ml-4 shrink-0"
          :disabled="!canDelete"
          @click="deleteConfirmOpen = true"
        >
          {{ t('account_settings.delete_button') }}
        </AtomsBaseButton>
      </div>
    </div>
  </div>

  <!-- Transfer ownership dialog -->
  <DialogRoot v-model:open="transferDialogOpen">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent
      >
        <div class="flex items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
            {{ t('account_settings.transfer_dialog_title') }}
          </DialogTitle>
          <DialogClose class="rounded-lg p-1.5 text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900">
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
          </DialogClose>
        </div>
        <div class="px-6 py-5">
          <p class="text-sm text-body dark:text-secondary-300">
            {{ t('account_settings.transfer_dialog_description', { workspace: transferTarget?.workspaceName ?? '' }) }}
          </p>
          <div class="mt-4 space-y-2">
            <AtomsFormLabel :text="t('account_settings.transfer_select_admin')" size="sm" />
            <template v-for="ws in blockingWorkspaces.filter(w => w.id === transferTarget?.workspaceId)" :key="ws.id">
              <button
                v-for="member in getAdminMembers(ws)"
                :key="member.id"
                type="button"
                class="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :class="selectedMemberId === member.id ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10' : 'border-secondary-200 dark:border-secondary-800 hover:bg-secondary-50 dark:hover:bg-secondary-900'"
                @click="selectedMemberId = member.id"
              >
                <AtomsAvatar
                  :src="member.profiles?.avatar_url"
                  :name="member.profiles?.display_name || member.profiles?.email"
                  size="sm"
                />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-heading dark:text-secondary-100">
                    {{ member.profiles?.display_name || member.profiles?.email }}
                  </p>
                  <p v-if="member.profiles?.display_name" class="text-xs text-muted">
                    {{ member.profiles?.email }}
                  </p>
                </div>
                <span
                  v-if="selectedMemberId === member.id"
                  class="icon-[annon--check] size-4 text-primary-500"
                  aria-hidden="true"
                />
              </button>
            </template>
          </div>
        </div>
        <div class="flex items-center justify-end gap-2 border-t border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <DialogClose as-child>
            <AtomsBaseButton size="sm">
              {{ t('common.cancel') }}
            </AtomsBaseButton>
          </DialogClose>
          <AtomsBaseButton
            variant="primary"
            size="sm"
            :disabled="!selectedMemberId || !!transferring"
            @click="handleTransfer"
          >
            {{ t('account_settings.transfer_confirm_button') }}
          </AtomsBaseButton>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <!-- Account delete confirmation -->
  <MoleculesConfirmDeleteDialog
    v-model:open="deleteConfirmOpen"
    :title="t('account_settings.delete_title')"
    :description="t('account_settings.delete_description')"
    :confirm-text="authState.user?.email ?? ''"
    :confirm-label="t('account_settings.delete_confirm_label')"
    :delete-label="deleting ? t('danger_zone.deleting') : t('account_settings.delete_button')"
    :deleting="deleting"
    @confirm="handleDeleteAccount"
  />
</template>
