<script setup lang="ts">
const props = defineProps<{
  workspaceId: string
  projectId: string
}>()

const { t } = useContent()
const toast = useToast()
const { isOwnerOrAdmin } = useWorkspaceRole()

type Provider = 'netlify' | 'vercel' | 'cloudflare-pages' | 'generic'

interface DeployState {
  target: {
    provider: Provider
    hookHint: string
    triggers: { on_publish: boolean, on_schedule: boolean }
    updatedAt: string
    lastTriggeredAt: string | null
    lastStatus: number | null
  } | null
  scheduled: Array<{ id: string, modelId: string, entryId: string, locale: string, kind: string, fireAt: string }>
}

const state = ref<DeployState | null>(null)
const loading = ref(true)
const busy = ref<'save' | 'remove' | 'trigger' | null>(null)

const provider = ref<Provider>('netlify')
const hookUrl = ref('')
const onPublish = ref(true)
const onSchedule = ref(true)

const base = () => `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/deploy`

const providerOptions = computed(() => [
  { value: 'netlify', label: t('deploy.provider_netlify') },
  { value: 'vercel', label: t('deploy.provider_vercel') },
  { value: 'cloudflare-pages', label: t('deploy.provider_cloudflare') },
  { value: 'generic', label: t('deploy.provider_generic') },
])

async function load() {
  if (!isOwnerOrAdmin.value) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    state.value = await $fetch<DeployState>(base())
    if (state.value.target) {
      provider.value = state.value.target.provider
      onPublish.value = state.value.target.triggers.on_publish
      onSchedule.value = state.value.target.triggers.on_schedule
    }
  }
  catch {
    state.value = null
  }
  finally {
    loading.value = false
  }
}

watch(() => props.projectId, load, { immediate: true })

const canSave = computed(() => {
  if (!state.value?.target) return hookUrl.value.trim().length > 0
  return hookUrl.value.trim().length > 0
    || provider.value !== state.value.target.provider
    || onPublish.value !== state.value.target.triggers.on_publish
    || onSchedule.value !== state.value.target.triggers.on_schedule
})

async function save() {
  busy.value = 'save'
  try {
    await $fetch(base(), {
      method: 'PATCH',
      body: {
        provider: provider.value,
        hookUrl: hookUrl.value.trim() || undefined,
        triggers: { on_publish: onPublish.value, on_schedule: onSchedule.value },
      },
    })
    hookUrl.value = ''
    toast.success(t('deploy.saved'))
    await load()
  }
  catch {
    toast.error(t('deploy.save_failed'))
  }
  finally {
    busy.value = null
  }
}

async function remove() {
  busy.value = 'remove'
  try {
    await $fetch(base(), { method: 'DELETE' })
    toast.success(t('deploy.removed'))
    await load()
  }
  catch {
    toast.error(t('deploy.save_failed'))
  }
  finally {
    busy.value = null
  }
}

async function trigger() {
  busy.value = 'trigger'
  try {
    const result = await $fetch<{ status: number }>(`${base()}/trigger`, { method: 'POST' })
    toast.success(t('deploy.triggered', { status: result.status }))
    await load()
  }
  catch {
    toast.error(t('deploy.trigger_failed'))
  }
  finally {
    busy.value = null
  }
}

function formatDate(value: string | null): string {
  if (!value) return t('deploy.never')
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleString()
}
</script>

<template>
  <section v-if="isOwnerOrAdmin" class="space-y-4 border-t border-secondary-200 p-5 dark:border-secondary-800">
    <div class="flex items-start gap-3">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-900/20">
        <span class="icon-[annon--rocket] size-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
      </div>
      <div class="flex-1">
        <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
          {{ t('deploy.title') }}
        </h4>
        <p class="mt-0.5 text-xs text-muted">
          {{ t('deploy.description') }}
        </p>
      </div>
    </div>

    <div v-if="loading" class="space-y-2 pl-11">
      <AtomsSkeleton variant="custom" class="h-8 w-full rounded-lg" />
      <AtomsSkeleton variant="custom" class="h-8 w-2/3 rounded-lg" />
    </div>

    <div v-else class="space-y-4 pl-11">
      <div v-if="state?.target" class="rounded-lg border border-secondary-200 bg-secondary-50 px-3 py-2 text-xs dark:border-secondary-800 dark:bg-secondary-900">
        <p class="text-body dark:text-secondary-300">
          <span class="text-label">{{ t('deploy.hook_hint') }}:</span> <code class="font-mono">{{ state.target.hookHint }}</code>
        </p>
        <p class="mt-1 text-muted">
          {{ t('deploy.last_triggered') }}: {{ formatDate(state.target.lastTriggeredAt) }}<span v-if="state.target.lastStatus !== null"> · HTTP {{ state.target.lastStatus }}</span>
        </p>
      </div>

      <div>
        <AtomsFormLabel for="deploy-provider">
          {{ t('deploy.provider') }}
        </AtomsFormLabel>
        <AtomsFormSelect
          :model-value="provider"
          :options="providerOptions"
          size="sm"
          @update:model-value="provider = $event as Provider"
        />
      </div>

      <div>
        <AtomsFormLabel for="deploy-hook-url">
          {{ t('deploy.hook_url') }}
        </AtomsFormLabel>
        <p class="mb-1.5 text-xs text-muted">
          {{ t('deploy.hook_url_description') }}
        </p>
        <AtomsFormInput
          id="deploy-hook-url"
          type="url"
          :model-value="hookUrl"
          placeholder="https://api.netlify.com/build_hooks/…"
          autocomplete="off"
          @update:model-value="hookUrl = $event"
        />
      </div>

      <div class="flex items-center justify-between">
        <span class="text-sm text-heading dark:text-secondary-100">{{ t('deploy.on_publish') }}</span>
        <AtomsFormSwitch :model-value="onPublish" @update:model-value="onPublish = $event" />
      </div>
      <div class="flex items-center justify-between">
        <span class="text-sm text-heading dark:text-secondary-100">{{ t('deploy.on_schedule') }}</span>
        <AtomsFormSwitch :model-value="onSchedule" @update:model-value="onSchedule = $event" />
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <AtomsBaseButton type="button" variant="primary" size="sm" :disabled="!canSave || busy !== null" @click="save">
          {{ busy === 'save' ? t('common.loading') : t('deploy.save') }}
        </AtomsBaseButton>
        <AtomsBaseButton v-if="state?.target" type="button" variant="secondary" size="sm" :disabled="busy !== null" @click="trigger">
          {{ busy === 'trigger' ? t('common.loading') : t('deploy.trigger') }}
        </AtomsBaseButton>
        <AtomsBaseButton v-if="state?.target" type="button" variant="danger" size="sm" class="ml-auto" :disabled="busy !== null" @click="remove">
          {{ t('deploy.remove') }}
        </AtomsBaseButton>
      </div>

      <div>
        <h5 class="text-xs font-semibold uppercase tracking-wider text-muted">
          {{ t('deploy.scheduled_title') }}
        </h5>
        <p v-if="!state?.scheduled?.length" class="mt-1 text-xs text-muted">
          {{ t('deploy.scheduled_empty') }}
        </p>
        <ul v-else class="mt-1 space-y-1 text-xs text-body dark:text-secondary-300">
          <li v-for="row in state.scheduled" :key="row.id" class="flex items-center justify-between gap-2">
            <span class="truncate">{{ t('deploy.scheduled_row', { kind: row.kind, model: row.modelId, entry: row.entryId, locale: row.locale }) }}</span>
            <span class="shrink-0 text-muted">{{ formatDate(row.fireAt) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
