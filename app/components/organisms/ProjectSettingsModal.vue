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
  config: {
    workflow?: string
    stack?: string
    domains?: string[]
    locales?: { default?: string, supported?: string[] }
  } | null
}>()

const emit = defineEmits<{
  saved: []
}>()

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
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
        @interact-outside.prevent
      >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-secondary-200 px-5 py-4 dark:border-secondary-800">
          <div>
            <DialogTitle class="text-base font-semibold text-heading dark:text-secondary-100">
              {{ t('project_settings.title') }}
            </DialogTitle>
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

        <!-- Body -->
        <div class="max-h-[60vh] space-y-5 overflow-y-auto px-5 py-4">
          <!-- Workflow -->
          <div>
            <AtomsFormLabel :text="t('project_settings.workflow')" size="sm" />
            <div class="mt-2 flex gap-2">
              <button
                type="button"
                class="flex-1 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                :class="workflow === 'auto-merge'
                  ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-400 dark:bg-primary-900/20 dark:text-primary-300'
                  : 'border-secondary-200 text-body hover:border-secondary-300 dark:border-secondary-700 dark:text-secondary-400 dark:hover:border-secondary-600'
                "
                @click="workflow = 'auto-merge'"
              >
                <div class="font-medium">
                  {{ t('project_settings.workflow_auto') }}
                </div>
                <div class="mt-0.5 text-xs opacity-70">
                  {{ t('project_settings.workflow_auto_desc') }}
                </div>
              </button>
              <button
                type="button"
                :disabled="!canReview"
                class="flex-1 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                :class="workflow === 'review'
                  ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-400 dark:bg-primary-900/20 dark:text-primary-300'
                  : 'border-secondary-200 text-body hover:border-secondary-300 dark:border-secondary-700 dark:text-secondary-400 dark:hover:border-secondary-600'
                "
                @click="canReview ? workflow = 'review' : undefined"
              >
                <div class="flex items-center gap-1.5 font-medium">
                  {{ t('project_settings.workflow_review') }}
                  <AtomsBadge v-if="!canReview" variant="info" size="sm">
                    Pro
                  </AtomsBadge>
                </div>
                <div class="mt-0.5 text-xs opacity-70">
                  {{ t('project_settings.workflow_review_desc') }}
                </div>
              </button>
            </div>
          </div>

          <!-- Stack (read-only) -->
          <div>
            <AtomsFormLabel :text="t('project_settings.stack')" size="sm" />
            <div class="mt-1.5">
              <AtomsBadge variant="secondary" size="md">
                {{ config?.stack ?? 'other' }}
              </AtomsBadge>
            </div>
          </div>

          <!-- Default Locale -->
          <div>
            <AtomsFormLabel :text="t('project_settings.default_locale')" size="sm" />
            <AtomsFormSelect
              :model-value="defaultLocale"
              :options="supportedLocales.map(l => ({ value: l, label: `${l.toUpperCase()} — ${getLocaleName(l)}` }))"
              size="md"
              class="mt-1.5"
              @update:model-value="defaultLocale = $event"
            />
          </div>

          <!-- Supported Locales -->
          <div>
            <AtomsFormLabel :text="t('project_settings.locales')" size="sm" />
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              <span
                v-for="locale in supportedLocales"
                :key="locale"
                class="inline-flex items-center gap-1 rounded-md bg-secondary-100 px-2 py-1 text-xs font-medium text-heading dark:bg-secondary-800 dark:text-secondary-100"
              >
                {{ locale.toUpperCase() }}
                <span class="text-[10px] font-normal text-muted">{{ getLocaleName(locale) }}</span>
                <button
                  v-if="supportedLocales.length > 1"
                  type="button"
                  class="ml-0.5 rounded text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  @click="removeLocale(locale)"
                >
                  <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
                </button>
              </span>
            </div>
            <!-- Searchable locale picker -->
            <ComboboxRoot
              class="relative mt-2"
              :model-value="''"
              :filter-function="filterLocales"
              @update:model-value="addLocale($event as string)"
            >
              <ComboboxAnchor class="flex items-center gap-1.5 rounded-lg border border-secondary-200 bg-white px-2.5 dark:border-secondary-700 dark:bg-secondary-900">
                <span class="icon-[annon--search] size-3.5 shrink-0 text-muted" aria-hidden="true" />
                <ComboboxInput
                  :placeholder="t('project_settings.locale_placeholder')"
                  class="h-8 flex-1 bg-transparent text-sm text-heading placeholder:text-disabled focus:outline-none dark:text-secondary-100"
                />
              </ComboboxAnchor>
              <ComboboxPortal>
                <ComboboxContent
                  position="popper"
                  :side-offset="4"
                  class="z-[100] max-h-48 w-[var(--radix-combobox-trigger-width)] overflow-hidden rounded-lg border border-secondary-200 bg-white shadow-lg dark:border-secondary-800 dark:bg-secondary-950"
                >
                  <ComboboxViewport class="p-1">
                    <ComboboxEmpty class="px-3 py-2 text-xs text-muted">
                      No matching language
                    </ComboboxEmpty>
                    <ComboboxItem
                      v-for="locale in availableLocales"
                      :key="locale.code"
                      :value="locale.code"
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

          <!-- Domains -->
          <div>
            <AtomsFormLabel :text="t('project_settings.domains')" size="sm" />
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              <span
                v-for="domain in domains"
                :key="domain"
                class="inline-flex items-center gap-1 rounded-md bg-secondary-100 px-2 py-1 text-xs font-medium text-heading dark:bg-secondary-800 dark:text-secondary-100"
              >
                {{ domain }}
                <button
                  type="button"
                  class="ml-0.5 rounded text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                  @click="removeDomain(domain)"
                >
                  <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
                </button>
              </span>
            </div>
            <form class="mt-2 flex items-center gap-2" @submit.prevent="addDomain">
              <AtomsFormInput
                v-model="newDomain"
                type="text"
                :placeholder="t('project_settings.domains_placeholder')"
                class="w-40"
              />
              <AtomsBaseButton type="submit" variant="ghost" size="sm" :disabled="!newDomain.trim()">
                <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
              </AtomsBaseButton>
            </form>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-end gap-2 border-t border-secondary-200 px-5 py-3 dark:border-secondary-800">
          <AtomsBaseButton variant="ghost" size="md" @click="open = false">
            {{ t('common.cancel') }}
          </AtomsBaseButton>
          <AtomsBaseButton
            variant="primary"
            size="md"
            :disabled="!hasChanges || saving"
            @click="save"
          >
            {{ saving ? t('project_settings.saving') : t('common.save_changes') }}
          </AtomsBaseButton>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
