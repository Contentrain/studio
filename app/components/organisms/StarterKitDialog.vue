<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from 'radix-vue'
import type { Starters } from '#contentrain'

const { t } = useContent()
const { activeWorkspace } = useWorkspaces()
const toast = useToast()
const router = useRouter()
const { starters } = useStarters()

const open = defineModel<boolean>('open', { default: false })

const hasInstallation = computed(() => !!activeWorkspace.value?.github_installation_id)

// State machine
type DialogState = 'install' | 'select' | 'configure'

const state = ref<DialogState>('select')
const selectedStarter = ref<Starters | null>(null)
const repoName = ref('')
const isPrivate = ref(false)
const creating = ref(false)

// Framework filter
const activeFilter = ref<string | null>(null)

const frameworks = computed(() => {
  const set = new Set(starters.value.map(s => s.framework))
  return Array.from(set)
})

const filteredStarters = computed(() => {
  if (!activeFilter.value) return starters.value
  return starters.value.filter(s => s.framework === activeFilter.value)
})

// Reset on close, check installation on open
watch(open, (isOpen) => {
  if (!isOpen) {
    state.value = 'select'
    selectedStarter.value = null
    repoName.value = ''
    isPrivate.value = false
    activeFilter.value = null
    return
  }
  // Check installation when opening
  state.value = hasInstallation.value ? 'select' : 'install'
})

function installGitHubApp() {
  window.open(
    getGitHubAppInstallUrl(),
    '_blank',
    'noopener,noreferrer',
  )
}

function selectStarter(starter: Starters) {
  selectedStarter.value = starter
  repoName.value = starter.slug
  state.value = 'configure'
}

function goBack() {
  state.value = 'select'
  selectedStarter.value = null
  repoName.value = ''
}

const repoNameError = computed(() => {
  if (!repoName.value) return ''
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(repoName.value))
    return t('starters.invalid_repo_name')
  return ''
})

async function createFromStarter() {
  if (!activeWorkspace.value || !selectedStarter.value || repoNameError.value) return
  creating.value = true

  try {
    // 1. Create repo from template
    const newRepo = await $fetch('/api/github/create-from-template', {
      method: 'POST',
      body: {
        workspaceId: activeWorkspace.value.id,
        templateRepo: selectedStarter.value.repo,
        name: repoName.value,
        isPrivate: isPrivate.value,
        description: selectedStarter.value.description,
      },
    })

    // 2. If App can't access the new repo, user needs to update installation settings
    if (newRepo.needsAccess) {
      toast.warning(t('starters.needs_access'))
      // Open GitHub App settings so user can add the repo
      window.open(
        `https://github.com/settings/installations/${activeWorkspace.value.github_installation_id}`,
        '_blank',
        'noopener,noreferrer',
      )
      open.value = false
      return
    }

    // 3. Connect as project — template already has .contentrain/
    const project = await $fetch(`/api/workspaces/${activeWorkspace.value.id}/projects`, {
      method: 'POST',
      body: {
        repoFullName: newRepo.fullName,
        defaultBranch: newRepo.defaultBranch,
        detectedStack: selectedStarter.value.framework,
        hasContentrain: true,
      },
    })

    toast.success(t('starters.created_success'))
    open.value = false

    // Navigate to the new project
    const slug = useRoute().params.slug as string
    await router.push(`/w/${slug}/projects/${project.id}`)
  }
  catch (e: unknown) {
    const err = e as { data?: { message?: string } }
    const message = err.data?.message || t('starters.created_error')
    toast.error(message)
  }
  finally {
    creating.value = false
  }
}

function frameworkLabel(fw: string): string {
  const labels: Record<string, string> = {
    astro: 'Astro',
    nuxt: 'Nuxt',
    next: 'Next.js',
    sveltekit: 'SvelteKit',
    vitepress: 'VitePress',
  }
  return labels[fw] ?? fw
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogTrigger as-child>
      <slot />
    </DialogTrigger>

    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />

      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
      >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
            {{ state === 'select' ? t('starters.title') : t('starters.configure_title') }}
          </DialogTitle>
          <DialogDescription class="sr-only">
            {{ t('starters.description') }}
          </DialogDescription>
          <DialogClose
            class="rounded-lg p-1.5 text-muted transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
            <span class="sr-only">{{ t('common.close') }}</span>
          </DialogClose>
        </div>

        <!-- STATE 0: Install GitHub App -->
        <div v-if="state === 'install'" class="px-6 py-12">
          <AtomsEmptyState
            icon="icon-[annon--link-1]"
            :title="t('github.install_title')"
            :description="t('github.install_description')"
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
          <p class="mt-2 text-center text-xs text-muted">
            {{ t('github.install_hint') }}
          </p>
        </div>

        <!-- STATE 1: Select Starter -->
        <div v-else-if="state === 'select'" class="flex max-h-[70vh] flex-col">
          <!-- Framework filter chips -->
          <div class="flex flex-wrap gap-2 border-b border-secondary-200 px-6 py-3 dark:border-secondary-800">
            <button
              type="button"
              class="rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
              :class="activeFilter === null
                ? 'bg-primary-600 text-white dark:bg-primary-500'
                : 'bg-secondary-100 text-body hover:bg-secondary-200 dark:bg-secondary-800 dark:text-secondary-300 dark:hover:bg-secondary-700'"
              @click="activeFilter = null"
            >
              {{ t('common.all') }}
            </button>
            <button
              v-for="fw in frameworks" :key="fw"
              type="button"
              class="rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
              :class="activeFilter === fw
                ? 'bg-primary-600 text-white dark:bg-primary-500'
                : 'bg-secondary-100 text-body hover:bg-secondary-200 dark:bg-secondary-800 dark:text-secondary-300 dark:hover:bg-secondary-700'"
              @click="activeFilter = fw"
            >
              {{ frameworkLabel(fw) }}
            </button>
          </div>

          <!-- Starter grid -->
          <div class="flex-1 overflow-y-auto px-6 py-4">
            <div class="grid gap-3 sm:grid-cols-2">
              <button
                v-for="starter in filteredStarters" :key="starter.id"
                type="button"
                class="group flex flex-col rounded-xl border border-secondary-200 p-4 text-left transition-[color,border-color,box-shadow] hover:border-primary-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-800 dark:hover:border-primary-700"
                @click="selectStarter(starter)"
              >
                <!-- Framework icon + name -->
                <div class="flex items-center gap-3">
                  <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary-50 dark:bg-secondary-900">
                    <img
                      :src="starter.framework_icon"
                      :alt="frameworkLabel(starter.framework)"
                      class="size-5"
                    >
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
                      {{ starter.name }}
                    </div>
                    <div class="text-xs text-muted">
                      {{ frameworkLabel(starter.framework) }}
                    </div>
                  </div>
                  <span
                    class="icon-[annon--chevron-right] size-4 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden="true"
                  />
                </div>

                <!-- Description -->
                <p class="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted">
                  {{ starter.description }}
                </p>

                <!-- Tags -->
                <div v-if="starter.tags?.length" class="mt-3 flex flex-wrap gap-1">
                  <AtomsBadge v-for="tag in starter.tags" :key="tag" variant="secondary" size="sm">
                    {{ tag }}
                  </AtomsBadge>
                </div>
              </button>
            </div>
          </div>
        </div>

        <!-- STATE 2: Configure -->
        <div v-else-if="state === 'configure'" class="px-6 py-6">
          <!-- Selected starter header -->
          <div class="flex items-center gap-3">
            <div class="flex size-10 items-center justify-center rounded-lg bg-secondary-50 dark:bg-secondary-900">
              <img
                v-if="selectedStarter"
                :src="selectedStarter.framework_icon"
                :alt="frameworkLabel(selectedStarter.framework)"
                class="size-5"
              >
            </div>
            <div class="min-w-0 flex-1">
              <AtomsHeadingText :level="3" size="xs" truncate>
                {{ selectedStarter?.name }}
              </AtomsHeadingText>
              <p class="text-xs text-muted">
                {{ selectedStarter?.description }}
              </p>
            </div>
          </div>

          <!-- Form -->
          <div class="mt-6 space-y-4">
            <!-- Repo name -->
            <div>
              <AtomsFormLabel :for-id="'starter-repo-name'">
                {{ t('starters.repo_name_label') }}
              </AtomsFormLabel>
              <AtomsFormInput
                id="starter-repo-name"
                v-model="repoName"
                :placeholder="t('starters.repo_name_placeholder')"
                :state="repoNameError ? 'error' : 'default'"
                :description="repoNameError || undefined"
              />
            </div>

            <!-- Visibility toggle -->
            <div class="flex items-center justify-between rounded-lg border border-secondary-200 px-4 py-3 dark:border-secondary-800">
              <div>
                <p class="text-sm font-medium text-heading dark:text-secondary-100">
                  {{ t('starters.private_repo') }}
                </p>
                <p class="text-xs text-muted">
                  {{ t('starters.private_repo_hint') }}
                </p>
              </div>
              <AtomsFormSwitch v-model="isPrivate" />
            </div>
          </div>

          <!-- Actions -->
          <div class="mt-6 flex items-center justify-between">
            <AtomsBaseButton size="sm" @click="goBack">
              <template #prepend>
                <span class="icon-[annon--arrow-left] size-4" aria-hidden="true" />
              </template>
              <span>{{ t('common.back') }}</span>
            </AtomsBaseButton>
            <AtomsBaseButton
              variant="primary"
              size="md"
              :disabled="!repoName || !!repoNameError || creating"
              @click="createFromStarter"
            >
              <template v-if="creating" #prepend>
                <div class="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              </template>
              <template v-else #prepend>
                <span class="icon-[annon--plus] size-4" aria-hidden="true" />
              </template>
              <span>{{ creating ? t('starters.creating') : t('starters.create_project') }}</span>
            </AtomsBaseButton>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
