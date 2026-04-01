<script setup lang="ts">
const { state: authState, refreshUser } = useAuth()
const { t } = useContent()
const toast = useToast()

const saving = ref(false)
const displayName = ref(authState.value.user?.displayName ?? '')

// Sync from auth state when it changes (e.g. after init)
watch(() => authState.value.user?.displayName, (name) => {
  if (name !== undefined) displayName.value = name ?? ''
})

const hasChanges = computed(() =>
  displayName.value.trim() !== (authState.value.user?.displayName ?? ''),
)

const canSave = computed(() => hasChanges.value && displayName.value.trim().length > 0)

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    await $fetch('/api/profile', {
      method: 'PATCH',
      body: { displayName: displayName.value.trim() },
    })
    await refreshUser()
    toast.success(t('account_settings.save_success'))
  }
  catch (e: unknown) {
    const message = e instanceof Error ? e.message : t('account_settings.save_error')
    toast.error(message)
  }
  finally {
    saving.value = false
  }
}

const providerLabel = computed(() => {
  const p = authState.value.user?.provider
  if (p === 'github') return 'GitHub'
  if (p === 'google') return 'Google'
  if (p === 'email') return 'Email (Magic Link)'
  return p ?? 'Unknown'
})

const providerVariant = computed(() => {
  const p = authState.value.user?.provider
  if (p === 'github') return 'secondary' as const
  if (p === 'google') return 'info' as const
  return 'primary' as const
})

// Avatar upload
const uploading = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)

const hasCustomAvatar = computed(() => {
  const url = authState.value.user?.avatarUrl
  return url?.startsWith('data:') ?? false
})

function triggerFileInput() {
  fileInputRef.value?.click()
}

async function handleAvatarUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    await $fetch('/api/profile/avatar', { method: 'POST', body: formData })
    await refreshUser()
    toast.success(t('account_settings.avatar_upload_success'))
  }
  catch (e: unknown) {
    const message = e instanceof Error ? e.message : t('account_settings.avatar_upload_error')
    toast.error(message)
  }
  finally {
    uploading.value = false
    if (target) target.value = ''
  }
}

async function handleAvatarRemove() {
  uploading.value = true
  try {
    await $fetch('/api/profile/avatar', { method: 'DELETE' })
    await refreshUser()
    toast.success(t('account_settings.avatar_remove_success'))
  }
  catch {
    toast.error(t('account_settings.avatar_remove_error'))
  }
  finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="max-w-md space-y-5">
    <!-- Avatar (editable) -->
    <div>
      <div class="flex items-center gap-1">
        <AtomsFormLabel :text="t('account_settings.avatar_label')" size="sm" />
        <AtomsInfoTooltip :text="t('account_settings.avatar_edit_info')" />
      </div>
      <div class="mt-2 flex items-center gap-3">
        <div class="relative">
          <AtomsAvatar
            :src="authState.user?.avatarUrl"
            :name="authState.user?.displayName || authState.user?.email"
            size="lg"
          />
          <button
            type="button"
            class="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            :disabled="uploading"
            @click="triggerFileInput"
          >
            <span class="icon-[annon--camera] size-5 text-white" aria-hidden="true" />
          </button>
        </div>
        <div class="flex flex-col gap-1">
          <AtomsBaseButton size="sm" :disabled="uploading" @click="triggerFileInput">
            {{ t('account_settings.avatar_upload_button') }}
          </AtomsBaseButton>
          <AtomsBaseButton
            v-if="hasCustomAvatar"
            variant="ghost"
            size="sm"
            :disabled="uploading"
            @click="handleAvatarRemove"
          >
            {{ t('account_settings.avatar_remove_button') }}
          </AtomsBaseButton>
        </div>
        <input
          ref="fileInputRef"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          class="hidden"
          @change="handleAvatarUpload"
        >
      </div>
    </div>

    <!-- Display Name (editable) -->
    <div>
      <div class="flex items-center gap-1">
        <AtomsFormLabel for="display-name" :text="t('account_settings.display_name_label')" size="sm" />
        <AtomsInfoTooltip :text="t('account_settings.display_name_info')" />
      </div>
      <AtomsFormInput
        id="display-name"
        v-model="displayName"
        type="text"
        :placeholder="t('account_settings.display_name_placeholder')"
        class="mt-1.5"
      />
    </div>

    <!-- Email (read-only) -->
    <div>
      <div class="flex items-center gap-1">
        <AtomsFormLabel :text="t('account_settings.email_label')" size="sm" />
        <AtomsInfoTooltip :text="t('account_settings.email_info')" />
      </div>
      <div class="mt-1.5 flex items-center gap-2 rounded-lg border border-secondary-200 bg-secondary-50 px-3 py-2 dark:border-secondary-700 dark:bg-secondary-900">
        <span class="icon-[annon--lock] size-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span class="text-sm text-body dark:text-secondary-300">
          {{ authState.user?.email ?? '—' }}
        </span>
      </div>
    </div>

    <!-- Connected Account (read-only) -->
    <div>
      <div class="flex items-center gap-1">
        <AtomsFormLabel :text="t('account_settings.connected_account_label')" size="sm" />
        <AtomsInfoTooltip :text="t('account_settings.connected_account_info')" />
      </div>
      <div class="mt-1.5">
        <AtomsBadge :variant="providerVariant" size="md">
          {{ providerLabel }}
        </AtomsBadge>
      </div>
    </div>

    <!-- Save -->
    <AtomsBaseButton
      variant="primary"
      size="md"
      :disabled="!canSave || saving"
      @click="save"
    >
      {{ t('common.save_changes') }}
    </AtomsBaseButton>
  </div>
</template>
