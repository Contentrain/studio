<script setup lang="ts">
/**
 * OAuth consent screen — /oauth/consent.
 *
 * Rendered after /oauth/authorize validated the request and sealed it into
 * the flow cookie. The relying party is identified by the HOST of its
 * client_id URL (CIMD spec requirement — client_name is self-asserted and
 * only shown as secondary text). The final redirect back to the client must
 * be a top-level navigation (loopback redirect URIs), hence
 * window.location.href instead of router navigation.
 */
definePageMeta({
  layout: false,
})

interface ConsentProject {
  id: string
  repoFullName: string | null
  eligible: boolean
  reason: string | null
}

interface ConsentWorkspace {
  id: string
  name: string | null
  slug: string | null
  role: string
  eligible: boolean
  reason: string | null
  projects: ConsentProject[]
}

interface ConsentData {
  client: {
    displayHost: string
    name: string | null
    logoUri: string | null
    loopbackOnly: boolean
  }
  scope: string
  scopes: string[]
  workspaces: ConsentWorkspace[]
}

const { t } = useContent()

useHead({ title: () => t('oauth_consent.title') })

const data = ref<ConsentData | null>(null)
const loadError = ref('')
const submitting = ref(false)
const submitError = ref('')
const selectedWorkspaceId = ref<string | null>(null)
const selectedProjectId = ref<string | null>(null)

const SCOPE_LABEL_KEYS: Record<string, string> = {
  'content:read': 'oauth_consent.scope_read',
  'content:write': 'oauth_consent.scope_write',
  'project:metadata': 'oauth_consent.scope_metadata',
  'media:read': 'oauth_consent.scope_media_read',
  'media:write': 'oauth_consent.scope_media_write',
  'offline_access': 'oauth_consent.scope_offline',
}

const selectedWorkspace = computed(() =>
  data.value?.workspaces.find(w => w.id === selectedWorkspaceId.value) ?? null,
)

const canApprove = computed(() => {
  if (!selectedWorkspace.value?.eligible || !selectedProjectId.value) return false
  const project = selectedWorkspace.value.projects.find(p => p.id === selectedProjectId.value)
  return !!project?.eligible
})

function selectWorkspace(workspace: ConsentWorkspace) {
  if (!workspace.eligible) return
  selectedWorkspaceId.value = workspace.id
  const eligibleProjects = workspace.projects.filter(p => p.eligible)
  selectedProjectId.value = eligibleProjects.length === 1 ? eligibleProjects[0]!.id : null
}

function ineligibleLabel(reason: string | null): string {
  if (reason === 'ineligible_plan') return t('oauth_consent.ineligible_plan')
  if (reason === 'ineligible_no_repo') return t('oauth_consent.ineligible_no_repo')
  return t('oauth_consent.ineligible_no_installation')
}

onMounted(async () => {
  try {
    const result = await $fetch<ConsentData>('/api/oauth/consent')
    data.value = result

    const eligible = result.workspaces.filter(w => w.eligible && w.projects.some(p => p.eligible))
    if (eligible.length === 1) selectWorkspace(eligible[0]!)
  }
  catch (e: unknown) {
    loadError.value = resolveApiError(e, t('oauth_consent.load_failed'))
  }
})

async function decide(decision: 'approve' | 'deny') {
  submitting.value = true
  submitError.value = ''
  try {
    const result = await $fetch<{ redirectTo: string }>('/api/oauth/consent', {
      method: 'POST',
      body: decision === 'approve'
        ? { decision, workspaceId: selectedWorkspaceId.value, projectId: selectedProjectId.value }
        : { decision },
    })
    window.location.href = result.redirectTo
  }
  catch (e: unknown) {
    submitError.value = resolveApiError(e, t('oauth_consent.submit_failed'))
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-secondary-50 px-4 py-10 dark:bg-secondary-950">
    <div class="w-full max-w-lg">
      <div v-if="loadError" class="rounded-xl border border-border bg-white p-8 text-center dark:border-secondary-800 dark:bg-secondary-900">
        <p class="text-sm text-danger-600 dark:text-danger-400">
          {{ loadError }}
        </p>
      </div>

      <div v-else-if="!data" class="flex justify-center py-16">
        <AtomsSpinner :label="t('oauth_consent.loading')" />
      </div>

      <div v-else class="rounded-xl border border-border bg-white p-8 dark:border-secondary-800 dark:bg-secondary-900">
        <div class="flex items-center gap-4">
          <NuxtImg
            v-if="data.client.logoUri"
            :src="data.client.logoUri"
            :alt="data.client.displayHost"
            class="size-12 shrink-0 rounded-lg border border-border object-contain dark:border-secondary-800"
          />
          <div class="min-w-0">
            <AtomsHeadingText tag="h1" size="lg">
              {{ t('oauth_consent.title') }}
            </AtomsHeadingText>
            <p class="mt-1 truncate text-sm text-body dark:text-secondary-300">
              <span class="font-semibold text-heading dark:text-secondary-100">{{ data.client.displayHost }}</span>
              <span v-if="data.client.name && data.client.name !== data.client.displayHost" class="text-muted"> · {{ data.client.name }}</span>
            </p>
          </div>
        </div>

        <div
          v-if="data.client.loopbackOnly"
          class="mt-4 rounded-lg bg-warning-100 px-3 py-2 text-xs text-warning-800 dark:bg-warning-900/30 dark:text-warning-300"
        >
          {{ t('oauth_consent.localhost_warning') }}
        </div>

        <div class="mt-6">
          <AtomsSectionLabel :label="t('oauth_consent.permissions_label')" />
          <ul class="mt-2 space-y-1.5">
            <li
              v-for="scope in data.scopes"
              :key="scope"
              class="flex items-center gap-2 text-sm text-body dark:text-secondary-300"
            >
              <span class="icon-[annon--check] shrink-0 text-success-500" aria-hidden="true" />
              {{ SCOPE_LABEL_KEYS[scope] ? t(SCOPE_LABEL_KEYS[scope]!) : scope }}
            </li>
          </ul>
        </div>

        <div class="mt-6">
          <AtomsSectionLabel :label="t('oauth_consent.select_project')" />
          <div class="mt-2 max-h-72 space-y-3 overflow-y-auto pr-1">
            <div v-for="workspace in data.workspaces" :key="workspace.id">
              <button
                type="button"
                class="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :class="[
                  workspace.eligible
                    ? (selectedWorkspaceId === workspace.id
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                      : 'border-secondary-200 hover:bg-secondary-50 dark:border-secondary-800 dark:hover:bg-secondary-800')
                    : 'cursor-not-allowed border-secondary-200 opacity-60 dark:border-secondary-800',
                ]"
                :disabled="!workspace.eligible"
                @click="selectWorkspace(workspace)"
              >
                <span class="truncate font-medium text-heading dark:text-secondary-100">{{ workspace.name || workspace.slug }}</span>
                <span v-if="!workspace.eligible" class="ml-2 shrink-0 text-xs text-muted">
                  {{ ineligibleLabel(workspace.reason) }}
                </span>
              </button>

              <div v-if="selectedWorkspaceId === workspace.id" class="mt-1.5 space-y-1 pl-3">
                <p v-if="workspace.projects.length === 0" class="px-3 py-1.5 text-xs text-muted">
                  {{ t('oauth_consent.no_projects') }}
                </p>
                <label
                  v-for="project in workspace.projects"
                  :key="project.id"
                  class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  :class="[
                    project.eligible
                      ? (selectedProjectId === project.id
                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                        : 'cursor-pointer border-secondary-200 hover:bg-secondary-50 dark:border-secondary-800 dark:hover:bg-secondary-800')
                      : 'cursor-not-allowed border-secondary-200 opacity-60 dark:border-secondary-800',
                  ]"
                >
                  <input
                    v-model="selectedProjectId"
                    type="radio"
                    name="consent-project"
                    :value="project.id"
                    :disabled="!project.eligible"
                    class="accent-primary-600"
                  >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-heading dark:text-secondary-100">{{ project.repoFullName || project.id }}</span>
                  </span>
                  <span v-if="!project.eligible" class="shrink-0 text-xs text-muted">
                    {{ ineligibleLabel(project.reason) }}
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <p v-if="submitError" class="mt-4 text-sm text-danger-600 dark:text-danger-400">
          {{ submitError }}
        </p>

        <div class="mt-6 flex gap-3">
          <AtomsBaseButton
            variant="ghost"
            block
            :disabled="submitting"
            @click="decide('deny')"
          >
            {{ t('oauth_consent.deny') }}
          </AtomsBaseButton>
          <AtomsBaseButton
            variant="primary"
            block
            :disabled="submitting || !canApprove"
            @click="decide('approve')"
          >
            {{ t('oauth_consent.approve') }}
          </AtomsBaseButton>
        </div>
      </div>
    </div>
  </div>
</template>
