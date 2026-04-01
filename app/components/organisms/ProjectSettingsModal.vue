<script setup lang="ts">
import { ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxPortal, ComboboxRoot, ComboboxViewport, DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'
import { ISO_LOCALES, getLocaleName } from '~/utils/locales'

const { t } = useContent()
const toast = useToast()
const { activeWorkspace } = useWorkspaces()
const canReview = computed(() => hasFeature(activeWorkspace.value?.plan, 'workflow.review'))
const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  workspaceId: string
  projectId: string
  projectName?: string
  initialTab?: 'general' | 'api' | 'webhooks' | 'danger'
  config?: {
    workflow?: string
    stack?: string
    domains?: string[]
    locales?: { default?: string, supported?: string[] }
  } | null
}>()

const emit = defineEmits<{
  saved: []
  deleted: []
}>()

const { deleteProject } = useProjects()
const deleteConfirmOpen = ref(false)
const deleting = ref(false)
const activeTab = ref<'general' | 'api' | 'webhooks' | 'danger'>(props.initialTab ?? 'general')

// Sync tab when initialTab prop changes (e.g. from command palette)
watch(() => props.initialTab, (tab) => {
  if (tab) activeTab.value = tab
})

async function handleDeleteProject() {
  deleting.value = true
  const ok = await deleteProject(props.workspaceId, props.projectId)
  deleting.value = false

  if (ok) {
    toast.success(t('danger_zone.project_deleted'))
    deleteConfirmOpen.value = false
    open.value = false
    emit('deleted')
  }
  else {
    toast.error(t('danger_zone.project_delete_error'))
  }
}

// Local form state — initialized from config
const workflow = ref('auto-merge')
const domains = ref<string[]>([])
const defaultLocale = ref('en')
const supportedLocales = ref<string[]>(['en'])
const newDomain = ref('')
const saving = ref(false)

// Available locales = ISO list minus already selected
const availableLocales = computed(() =>
  ISO_LOCALES.filter(l => !supportedLocales.value.includes(l.code)),
)

// Custom filter: match by code OR name
function filterLocales(options: readonly string[], term: string): string[] {
  if (!term) return [...options]
  const q = term.toLowerCase()
  return options.filter((code) => {
    const locale = ISO_LOCALES.find(l => l.code === code)
    return code.toLowerCase().includes(q) || (locale?.name.toLowerCase().includes(q) ?? false)
  })
}

// Sync from props when modal opens
watch(open, async (isOpen) => {
  if (isOpen && props.config) {
    workflow.value = props.config.workflow ?? 'auto-merge'
    domains.value = [...(props.config.domains ?? [])]
    defaultLocale.value = props.config.locales?.default ?? 'en'
    supportedLocales.value = [...(props.config.locales?.supported ?? ['en'])]
  }
})

const hasChanges = computed(() => {
  if (!props.config) return false
  return workflow.value !== (props.config.workflow ?? 'auto-merge')
    || JSON.stringify(domains.value) !== JSON.stringify(props.config.domains ?? [])
    || defaultLocale.value !== (props.config.locales?.default ?? 'en')
    || JSON.stringify(supportedLocales.value) !== JSON.stringify(props.config.locales?.supported ?? ['en'])
})

function addDomain() {
  const d = newDomain.value.trim().toLowerCase()
  if (d && !domains.value.includes(d)) {
    domains.value.push(d)
  }
  newDomain.value = ''
}

function removeDomain(domain: string) {
  domains.value = domains.value.filter(d => d !== domain)
}

function addLocale(code: string) {
  if (code && !supportedLocales.value.includes(code)) {
    supportedLocales.value.push(code)
  }
}

function removeLocale(locale: string) {
  if (supportedLocales.value.length <= 1) return
  supportedLocales.value = supportedLocales.value.filter(l => l !== locale)
  if (defaultLocale.value === locale) {
    defaultLocale.value = supportedLocales.value[0] ?? 'en'
  }
}

async function save() {
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/config`, {
      method: 'PATCH',
      body: {
        workflow: workflow.value,
        domains: domains.value,
        locales: {
          default: defaultLocale.value,
          supported: supportedLocales.value,
        },
      },
    })
    toast.success(t('project_settings.save_success'))
    open.value = false
    emit('saved')
  }
  catch {
    toast.error(t('project_settings.save_error'))
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
      />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 flex w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-secondary-200 bg-white shadow-xl h-[80vh] dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center justify-between border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <div class="min-w-0 flex-1">
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('project_settings.title') }}
            </DialogTitle>
            <div class="mt-1 flex items-center gap-2">
              <span class="truncate text-sm text-muted">{{ projectName }}</span>
              <AtomsBadge v-if="config?.stack" variant="secondary" size="sm">
                {{ config.stack }}
              </AtomsBadge>
            </div>
            <DialogDescription class="sr-only">
              {{ t('project_settings.title') }}
            </DialogDescription>
          </div>
          <DialogClose
            class="rounded-md p-1 text-muted transition-colors hover:bg-secondary-100 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
          >
            <span class="icon-[annon--cross] block size-4" aria-hidden="true" />
          </DialogClose>
        </div>

        <!-- Tab bar -->
        <AtomsTabBar
          v-model="activeTab"
          :tabs="[
            { value: 'general', label: t('project_settings.general') },
            { value: 'api', label: t('conversation_keys.title') },
            { value: 'webhooks', label: t('webhooks.title') },
            { value: 'danger', label: t('danger_zone.title') },
          ]"
        />

        <!-- General Settings -->
        <div v-if="activeTab === 'general'" class="flex-1 overflow-y-auto">
          <div class="space-y-6 px-6 py-5">
            <!-- Section: Workflow -->
            <section aria-labelledby="section-workflow">
              <div class="flex items-start gap-3">
                <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-900/20">
                  <span class="icon-[annon--lightning] size-4 text-primary-500" aria-hidden="true" />
                </div>
                <div class="min-w-0 flex-1">
                  <h3 id="section-workflow" class="text-sm font-semibold text-heading dark:text-secondary-100">
                    {{ t('project_settings.workflow') }}
                  </h3>
                  <p class="mt-0.5 text-xs text-muted">
                    {{ t('project_settings.workflow_info') }}
                  </p>
                </div>
              </div>

              <div class="mt-3 grid grid-cols-2 gap-3" role="radiogroup" :aria-label="t('project_settings.workflow')">
                <!-- Auto-merge -->
                <button
                  type="button"
                  role="radio"
                  :aria-checked="workflow === 'auto-merge'"
                  class="relative rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  :class="workflow === 'auto-merge'
                    ? 'border-primary-500 bg-primary-50 dark:border-primary-400 dark:bg-primary-900/20'
                    : 'border-secondary-200 hover:border-secondary-300 dark:border-secondary-700 dark:hover:border-secondary-600'"
                  @click="workflow = 'auto-merge'"
                >
                  <div
                    class="absolute right-3 top-3 flex size-4 items-center justify-center rounded-full border-2"
                    :class="workflow === 'auto-merge'
                      ? 'border-primary-500 dark:border-primary-400'
                      : 'border-secondary-300 dark:border-secondary-600'"
                  >
                    <div v-if="workflow === 'auto-merge'" class="size-2 rounded-full bg-primary-500 dark:bg-primary-400" />
                  </div>
                  <span
                    class="icon-[annon--lightning] size-5"
                    :class="workflow === 'auto-merge' ? 'text-primary-500 dark:text-primary-400' : 'text-muted'"
                    aria-hidden="true"
                  />
                  <div
                    class="mt-2 text-sm font-medium"
                    :class="workflow === 'auto-merge' ? 'text-primary-700 dark:text-primary-300' : 'text-heading dark:text-secondary-100'"
                  >
                    {{ t('project_settings.workflow_auto') }}
                  </div>
                  <div
                    class="mt-0.5 text-xs"
                    :class="workflow === 'auto-merge' ? 'text-primary-600/70 dark:text-primary-300/70' : 'text-muted'"
                  >
                    {{ t('project_settings.workflow_auto_desc') }}
                  </div>
                </button>

                <!-- Review -->
                <button
                  type="button"
                  role="radio"
                  :aria-checked="workflow === 'review'"
                  class="relative rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  :class="workflow === 'review'
                    ? 'border-primary-500 bg-primary-50 dark:border-primary-400 dark:bg-primary-900/20'
                    : 'border-secondary-200 hover:border-secondary-300 dark:border-secondary-700 dark:hover:border-secondary-600'"
                  @click="canReview ? workflow = 'review' : toast.info(t('project_settings.workflow_pro_hint'))"
                >
                  <div
                    class="absolute right-3 top-3 flex size-4 items-center justify-center rounded-full border-2"
                    :class="workflow === 'review'
                      ? 'border-primary-500 dark:border-primary-400'
                      : 'border-secondary-300 dark:border-secondary-600'"
                  >
                    <div v-if="workflow === 'review'" class="size-2 rounded-full bg-primary-500 dark:bg-primary-400" />
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span
                      class="icon-[annon--check-circle] size-5"
                      :class="workflow === 'review' ? 'text-primary-500 dark:text-primary-400' : 'text-muted'"
                      aria-hidden="true"
                    />
                    <AtomsBadge v-if="!canReview" variant="info" size="sm">
                      Pro
                    </AtomsBadge>
                  </div>
                  <div
                    class="mt-2 text-sm font-medium"
                    :class="workflow === 'review' ? 'text-primary-700 dark:text-primary-300' : 'text-heading dark:text-secondary-100'"
                  >
                    {{ t('project_settings.workflow_review') }}
                  </div>
                  <div
                    class="mt-0.5 text-xs"
                    :class="workflow === 'review' ? 'text-primary-600/70 dark:text-primary-300/70' : 'text-muted'"
                  >
                    {{ canReview ? t('project_settings.workflow_review_desc') : t('project_settings.workflow_pro_hint') }}
                  </div>
                </button>
              </div>
            </section>

            <div class="border-b border-secondary-100 dark:border-secondary-800" />

            <!-- Section: Localization -->
            <section aria-labelledby="section-localization">
              <div class="flex items-start gap-3">
                <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info-50 dark:bg-info-900/20">
                  <span class="icon-[annon--globe] size-4 text-info-500" aria-hidden="true" />
                </div>
                <div class="min-w-0 flex-1">
                  <h3 id="section-localization" class="text-sm font-semibold text-heading dark:text-secondary-100">
                    {{ t('project_settings.localization_title') }}
                  </h3>
                  <p class="mt-0.5 text-xs text-muted">
                    {{ t('project_settings.localization_description') }}
                  </p>
                </div>
              </div>

              <div class="mt-3 space-y-4">
                <!-- Supported languages -->
                <div>
                  <AtomsFormLabel :text="t('project_settings.locales')" size="sm" />
                  <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span
                      v-for="locale in supportedLocales" :key="locale"
                      class="inline-flex items-center gap-1.5 rounded-full bg-secondary-100 px-2.5 py-1 text-xs font-medium text-heading dark:bg-secondary-800 dark:text-secondary-100"
                    >
                      {{ locale.toUpperCase() }}
                      <span class="text-[10px] text-muted">{{ getLocaleName(locale) }}</span>
                      <button
                        v-if="supportedLocales.length > 1" type="button"
                        class="ml-0.5 rounded-full p-0.5 text-muted transition-colors hover:bg-danger-50 hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-danger-900/20"
                        @click="removeLocale(locale)"
                      >
                        <span class="icon-[annon--cross] block size-2.5" aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                  <ComboboxRoot
                    class="relative mt-2" :model-value="''" :filter-function="filterLocales"
                    @update:model-value="addLocale($event as string)"
                  >
                    <ComboboxAnchor
                      class="flex items-center gap-1.5 rounded-lg border border-secondary-200 bg-white px-2.5 dark:border-secondary-700 dark:bg-secondary-900"
                    >
                      <span class="icon-[annon--search] size-3.5 shrink-0 text-muted" aria-hidden="true" />
                      <ComboboxInput
                        :placeholder="t('project_settings.locale_placeholder')"
                        class="h-8 flex-1 bg-transparent text-sm text-heading placeholder:text-disabled focus:outline-none dark:text-secondary-100"
                      />
                    </ComboboxAnchor>
                    <ComboboxPortal>
                      <ComboboxContent
                        position="popper" :side-offset="4"
                        class="z-100 max-h-48 w-(--radix-combobox-trigger-width) overflow-hidden rounded-lg border border-secondary-200 bg-white shadow-lg dark:border-secondary-800 dark:bg-secondary-950"
                      >
                        <ComboboxViewport class="p-1">
                          <ComboboxEmpty class="px-3 py-2 text-xs text-muted">
                            {{ t('common.no_results') }}
                          </ComboboxEmpty>
                          <ComboboxItem
                            v-for="locale in availableLocales" :key="locale.code" :value="locale.code"
                            class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-heading outline-none transition-colors data-highlighted:bg-secondary-50 dark:text-secondary-100 dark:data-highlighted:bg-secondary-900"
                          >
                            <span class="w-7 shrink-0 text-xs font-medium text-muted">{{ locale.code.toUpperCase() }}</span>
                            <span>{{ locale.name }}</span>
                            <ComboboxItemIndicator class="ml-auto">
                              <span class="icon-[annon--check] size-3.5 text-primary-500" aria-hidden="true" />
                            </ComboboxItemIndicator>
                          </ComboboxItem>
                        </ComboboxViewport>
                      </ComboboxContent>
                    </ComboboxPortal>
                  </ComboboxRoot>
                </div>

                <!-- Default language -->
                <div class="flex items-center justify-between rounded-lg border border-secondary-200 px-4 py-3 dark:border-secondary-800">
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-heading dark:text-secondary-100">
                      {{ t('project_settings.default_locale') }}
                    </div>
                    <p class="mt-0.5 text-xs text-muted">
                      {{ t('project_settings.default_locale_info') }}
                    </p>
                  </div>
                  <AtomsFormSelect
                    :model-value="defaultLocale"
                    :options="supportedLocales.map(l => ({ value: l, label: `${l.toUpperCase()} — ${getLocaleName(l)}` }))"
                    size="sm" class="ml-4 shrink-0"
                    @update:model-value="defaultLocale = $event"
                  />
                </div>
              </div>
            </section>

            <div class="border-b border-secondary-100 dark:border-secondary-800" />

            <!-- Section: Domains -->
            <section aria-labelledby="section-domains">
              <div class="flex items-start gap-3">
                <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success-50 dark:bg-success-900/20">
                  <span class="icon-[annon--link-1] size-4 text-success-500" aria-hidden="true" />
                </div>
                <div class="min-w-0 flex-1">
                  <h3 id="section-domains" class="text-sm font-semibold text-heading dark:text-secondary-100">
                    {{ t('project_settings.domains') }}
                  </h3>
                  <p class="mt-0.5 text-xs text-muted">
                    {{ t('project_settings.domains_info') }}
                  </p>
                </div>
              </div>

              <div class="mt-3">
                <!-- Domain list -->
                <div v-if="domains.length > 0" class="space-y-1.5">
                  <div
                    v-for="domain in domains" :key="domain"
                    class="flex items-center gap-3 rounded-lg border border-secondary-200 px-3 py-2.5 dark:border-secondary-800"
                  >
                    <span class="icon-[annon--globe] size-3.5 shrink-0 text-muted" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate text-sm text-heading dark:text-secondary-100">
                      {{ domain }}
                    </span>
                    <button
                      type="button"
                      class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-danger-50 hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-danger-900/20"
                      @click="removeDomain(domain)"
                    >
                      <span class="icon-[annon--trash] size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <!-- Add domain form -->
                <form class="mt-2 flex items-center gap-2" @submit.prevent="addDomain">
                  <div
                    class="flex flex-1 items-center gap-2 rounded-lg border border-secondary-200 bg-white px-3 transition-colors focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/30 dark:border-secondary-700 dark:bg-secondary-900"
                  >
                    <span class="icon-[annon--plus] size-3.5 shrink-0 text-muted" aria-hidden="true" />
                    <input
                      v-model="newDomain"
                      type="text"
                      :placeholder="t('project_settings.domains_placeholder')"
                      class="h-9 flex-1 bg-transparent text-sm text-heading placeholder:text-disabled focus:outline-none dark:text-secondary-100"
                    >
                  </div>
                  <AtomsBaseButton type="submit" variant="primary" size="sm" :disabled="!newDomain.trim()">
                    {{ t('common.add') }}
                  </AtomsBaseButton>
                </form>

                <div v-if="domains.length === 0" class="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-secondary-200 px-3 py-2.5 dark:border-secondary-700">
                  <span class="icon-[annon--link-1] size-3.5 shrink-0 text-muted" aria-hidden="true" />
                  <p class="text-xs text-muted">
                    {{ t('project_settings.domains_empty_hint') }}
                  </p>
                </div>
              </div>
            </section>
          </div>
        </div>

        <!-- Conversation API Keys -->
        <div v-else-if="activeTab === 'api'" class="flex-1 overflow-y-auto">
          <OrganismsConversationKeysPanel
            :workspace-id="workspaceId"
            :project-id="projectId"
          />
        </div>

        <!-- Webhooks -->
        <div v-else-if="activeTab === 'webhooks'" class="flex-1 overflow-y-auto">
          <OrganismsWebhookSettingsPanel
            :workspace-id="workspaceId"
            :project-id="projectId"
          />
        </div>

        <!-- Danger Zone -->
        <div v-else-if="activeTab === 'danger'" class="flex-1 overflow-y-auto px-6 py-5">
          <div class="flex items-start gap-3">
            <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-danger-50 dark:bg-danger-900/20">
              <span class="icon-[annon--alert-triangle] size-4 text-danger-500" aria-hidden="true" />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold text-danger-700 dark:text-danger-400">
                {{ t('danger_zone.project_delete_title') }}
              </h3>
              <p class="mt-0.5 text-xs text-muted">
                {{ t('danger_zone.project_delete_description') }}
              </p>
            </div>
          </div>
          <div class="mt-4 flex items-center justify-between rounded-lg border border-danger-200 px-4 py-3 dark:border-danger-500/20">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-heading dark:text-secondary-100">
                {{ projectName }}
              </p>
              <p class="mt-0.5 text-xs text-muted">
                {{ t('danger_zone.project_delete_description') }}
              </p>
            </div>
            <AtomsBaseButton variant="danger" size="sm" class="ml-4 shrink-0" @click="deleteConfirmOpen = true">
              {{ t('danger_zone.project_delete_button') }}
            </AtomsBaseButton>
          </div>
        </div>

        <!-- Footer (general tab only) -->
        <div
          v-if="activeTab === 'general'"
          class="flex shrink-0 items-center justify-end gap-2 border-t border-secondary-200 px-6 py-3 dark:border-secondary-800"
        >
          <AtomsBaseButton variant="ghost" size="md" @click="open = false">
            {{ t('common.cancel') }}
          </AtomsBaseButton>
          <AtomsBaseButton variant="primary" size="md" :disabled="!hasChanges || saving" @click="save">
            <template v-if="saving" #prepend>
              <div class="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            </template>
            {{ saving ? t('project_settings.saving') : t('common.save_changes') }}
          </AtomsBaseButton>
        </div>
      </DialogContent>
    </DialogPortal>

    <!-- Delete confirmation dialog -->
    <MoleculesConfirmDeleteDialog
      v-model:open="deleteConfirmOpen"
      :title="t('danger_zone.project_delete_title')"
      :description="t('danger_zone.project_delete_description')"
      :confirm-text="projectName ?? ''"
      :confirm-label="t('danger_zone.project_confirm_label')"
      :delete-label="deleting ? t('danger_zone.deleting') : t('danger_zone.project_delete_button')"
      :deleting="deleting"
      @confirm="handleDeleteProject"
    />
  </DialogRoot>
</template>
