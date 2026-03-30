<script setup lang="ts">
defineProps<{
  workspaceId: string
}>()

const { activeWorkspace } = useWorkspaces()
const { t } = useContent()

interface GitHubInstallation {
  installed: boolean
  installationId?: number
  account?: { login: string | null, avatarUrl: string | null, type: string }
  selection?: 'all' | 'selected'
  permissions?: Record<string, string>
  suspendedAt?: string | null
  repos?: Array<{ id: number, name: string, fullName: string, private: boolean, language: string | null }>
  settingsUrl?: string
  error?: string
}

const ghInstallation = ref<GitHubInstallation | null>(null)
const ghLoading = ref(false)

const ghIsSuspended = computed(() => !!ghInstallation.value?.suspendedAt)
const ghHasError = computed(() => !!ghInstallation.value?.error)
const ghNeedsAttention = computed(() => ghIsSuspended.value || ghHasError.value)

async function loadGitHubInstallation() {
  if (!activeWorkspace.value) return
  ghLoading.value = true
  try {
    ghInstallation.value = await $fetch<GitHubInstallation>('/api/github/installation', {
      params: { workspaceId: activeWorkspace.value.id },
    })
  }
  catch {
    ghInstallation.value = null
  }
  finally {
    ghLoading.value = false
  }
}

// Load on mount (tab is visible when this component renders)
onMounted(loadGitHubInstallation)

function openGitHubSettings() {
  if (ghInstallation.value?.settingsUrl) {
    window.open(ghInstallation.value.settingsUrl, '_blank', 'noopener,noreferrer')
  }
}

function installGitHubApp() {
  window.open(
    getGitHubAppInstallUrl(),
    '_blank',
    'noopener,noreferrer',
  )
}
</script>

<template>
  <div class="max-w-lg space-y-6">
    <!-- Loading -->
    <div v-if="ghLoading" class="space-y-3">
      <AtomsSkeleton variant="custom" class="h-20 w-full rounded-xl" />
      <AtomsSkeleton variant="custom" class="h-10 w-full rounded-lg" />
    </div>

    <!-- Not installed -->
    <template v-else-if="!activeWorkspace?.github_installation_id">
      <AtomsEmptyState
        illustration="/illustrations/connect-github.png"
        :title="t('settings.github_not_connected_title')"
        :description="t('settings.github_not_connected_hint')"
      >
        <template #action>
          <AtomsBaseButton variant="primary" size="md" @click="installGitHubApp">
            <template #prepend>
              <span class="icon-[annon--external-link] size-4" aria-hidden="true" />
            </template>
            {{ t('github.install_button') }}
          </AtomsBaseButton>
        </template>
      </AtomsEmptyState>
    </template>

    <!-- Installed -->
    <template v-else-if="ghInstallation?.installed">
      <!-- Alert: suspended or error -->
      <div
        v-if="ghNeedsAttention"
        class="flex items-start gap-3 rounded-xl border border-danger-200 bg-danger-50 p-4 dark:border-danger-500/20 dark:bg-danger-500/10"
      >
        <span class="icon-[annon--alert-triangle] size-5 shrink-0 text-danger-500" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-danger-700 dark:text-danger-400">
            {{ ghIsSuspended ? t('settings.github_suspended') : t('settings.github_error') }}
          </p>
          <p class="mt-1 text-xs text-danger-600 dark:text-danger-400/80">
            {{ ghIsSuspended ? t('settings.github_suspended_hint') : t('settings.github_error_hint') }}
          </p>
          <AtomsBaseButton variant="danger" size="sm" class="mt-3" @click="openGitHubSettings">
            {{ t('settings.github_manage') }}
          </AtomsBaseButton>
        </div>
      </div>

      <!-- Connected account card -->
      <div
        class="flex items-center gap-4 rounded-xl border p-4"
        :class="ghNeedsAttention
          ? 'border-danger-200 dark:border-danger-500/20'
          : 'border-secondary-200 dark:border-secondary-800'"
      >
        <AtomsAvatar
          v-if="ghInstallation.account?.avatarUrl"
          :src="ghInstallation.account.avatarUrl"
          :name="ghInstallation.account.login"
          size="lg"
        />
        <div v-else class="flex size-12 items-center justify-center rounded-full bg-secondary-100 dark:bg-secondary-800">
          <span class="icon-[annon--link-1] size-6 text-muted" aria-hidden="true" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold text-heading dark:text-secondary-100">
              {{ ghInstallation.account?.login ?? '—' }}
            </span>
            <AtomsBadge
              :variant="ghInstallation.account?.type === 'Organization' ? 'info' : 'secondary'"
              size="sm"
            >
              {{ ghInstallation.account?.type === 'Organization' ? t('settings.github_org') : t('settings.github_user') }}
            </AtomsBadge>
          </div>
          <div class="mt-0.5 flex items-center gap-2 text-xs text-muted">
            <span>{{ ghInstallation.selection === 'all' ? t('settings.github_all_repos') : t('settings.github_selected_repos') }}</span>
            <span v-if="ghInstallation.repos" class="text-disabled">·</span>
            <span v-if="ghInstallation.repos">{{ ghInstallation.repos.length }} {{ t('settings.github_repos_accessible') }}</span>
          </div>
        </div>
        <AtomsBadge :variant="ghNeedsAttention ? 'danger' : 'success'" size="sm">
          {{ ghNeedsAttention ? t('settings.github_attention') : t('common.connected') }}
        </AtomsBadge>
      </div>

      <!-- Actions -->
      <div class="flex items-center gap-2">
        <AtomsBaseButton size="sm" @click="openGitHubSettings">
          <template #prepend>
            <span class="icon-[annon--external-link] size-3.5" aria-hidden="true" />
          </template>
          {{ t('settings.github_manage') }}
        </AtomsBaseButton>
        <AtomsBaseButton size="sm" @click="loadGitHubInstallation">
          <template #prepend>
            <span class="icon-[annon--arrow-swap] size-3.5" aria-hidden="true" />
          </template>
          {{ t('settings.github_refresh') }}
        </AtomsBaseButton>
      </div>

      <!-- Accessible repos list -->
      <div v-if="ghInstallation.repos && ghInstallation.repos.length > 0 && !ghNeedsAttention">
        <div class="mb-2 flex items-center gap-1">
          <AtomsSectionLabel :label="t('settings.github_repos_title')" :count="ghInstallation.repos.length" />
          <AtomsInfoTooltip :text="t('settings.github_repos_info')" />
        </div>
        <ul class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800">
          <li
            v-for="repo in ghInstallation.repos" :key="repo.id"
            class="flex items-center gap-3 px-4 py-2.5"
          >
            <span class="icon-[annon--folder] size-4 shrink-0 text-muted" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-sm text-heading dark:text-secondary-100">
              {{ repo.name }}
            </span>
            <AtomsBadge v-if="repo.language" variant="secondary" size="sm">
              {{ repo.language }}
            </AtomsBadge>
            <span v-if="repo.private" class="icon-[annon--lock] size-3 text-muted" aria-hidden="true" />
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
