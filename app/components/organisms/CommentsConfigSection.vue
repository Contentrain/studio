<script setup lang="ts">
const props = defineProps<{
  workspaceId: string
  projectId: string
  modelId: string
  editable?: boolean
}>()

const { t } = useContent()
const toast = useToast()
const brain = useContentBrain()

interface CommentsConfigShape {
  enabled?: boolean
  requireApproval?: boolean
  maxDepth?: number
  requireEmail?: boolean
  honeypot?: boolean
  captcha?: 'turnstile' | null
  rateLimitPerIp?: number
  maxBodyLength?: number
}

const model = computed(() => brain.models.value.find(m => m.id === props.modelId))

const currentConfig = computed<CommentsConfigShape | null>(() => {
  if (!model.value) return null
  return (model.value as unknown as { comments?: CommentsConfigShape }).comments ?? null
})

const enabled = ref(false)
const requireApproval = ref(true)
const maxDepth = ref(4)
const requireEmail = ref(true)
const honeypot = ref(true)
const captcha = ref<'turnstile' | ''>('')
const rateLimitPerIp = ref(5)
const maxBodyLength = ref(5000)

function syncFromBrain() {
  const cfg = currentConfig.value
  enabled.value = cfg?.enabled ?? false
  requireApproval.value = cfg?.requireApproval ?? true
  maxDepth.value = cfg?.maxDepth ?? 4
  requireEmail.value = cfg?.requireEmail ?? true
  honeypot.value = cfg?.honeypot ?? true
  captcha.value = cfg?.captcha === 'turnstile' ? 'turnstile' : ''
  rateLimitPerIp.value = cfg?.rateLimitPerIp ?? 5
  maxBodyLength.value = cfg?.maxBodyLength ?? 5000
}

watch(() => props.modelId, syncFromBrain, { immediate: true })
watch(currentConfig, syncFromBrain)

const hasChanges = computed(() => {
  const cfg = currentConfig.value
  return enabled.value !== (cfg?.enabled ?? false)
    || requireApproval.value !== (cfg?.requireApproval ?? true)
    || maxDepth.value !== (cfg?.maxDepth ?? 4)
    || requireEmail.value !== (cfg?.requireEmail ?? true)
    || honeypot.value !== (cfg?.honeypot ?? true)
    || (captcha.value || null) !== (cfg?.captcha ?? null)
    || rateLimitPerIp.value !== (cfg?.rateLimitPerIp ?? 5)
    || maxBodyLength.value !== (cfg?.maxBodyLength ?? 5000)
})

const saving = ref(false)

async function save() {
  if (!hasChanges.value) return
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/models/${props.modelId}`, {
      method: 'PATCH',
      body: {
        comments: {
          enabled: enabled.value,
          requireApproval: requireApproval.value,
          maxDepth: maxDepth.value,
          requireEmail: requireEmail.value,
          honeypot: honeypot.value,
          captcha: captcha.value || null,
          rateLimitPerIp: rateLimitPerIp.value,
          maxBodyLength: maxBodyLength.value,
        },
      },
    })
    toast.success(t('comments.save_success'))
    await brain.sync(props.workspaceId, props.projectId)
  }
  catch {
    toast.error(t('comments.save_error'))
  }
  finally {
    saving.value = false
  }
}

const publicEndpoint = computed(() => `/api/comments/v1/${props.projectId}/${props.modelId}/{entryId}`)

// ── WordPress import (contentrain-comments@1 from `contentrain import`) ──

interface ImportSummary {
  received: number
  mapped: number
  inserted: number
  skippedExisting: number
  unmapped: Array<{ comment_id: number, post: number }>
  orphanCount: number
  threadsClosed: number
}

const IMPORT_CHUNK = 5000
const importing = ref(false)
const importResult = ref<ImportSummary | null>(null)
const importError = ref<string | null>(null)
const importInput = ref<HTMLInputElement | null>(null)

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importing.value = true
  importResult.value = null
  importError.value = null
  try {
    const payload = JSON.parse(await file.text()) as { format?: string, comments?: unknown[] }
    if (payload?.format !== 'contentrain-comments@1' || !Array.isArray(payload.comments))
      throw new Error('format')

    // Larger exports go up in chunks that share the entries map; the server keys rows on
    // the source id, so a retried chunk is a no-op and parents link across chunks.
    const total = payload.comments.length
    const summary: ImportSummary = { received: 0, mapped: 0, inserted: 0, skippedExisting: 0, unmapped: [], orphanCount: 0, threadsClosed: 0 }
    for (let offset = 0; offset < Math.max(total, 1); offset += IMPORT_CHUNK) {
      const chunk = { ...payload, comments: payload.comments.slice(offset, offset + IMPORT_CHUNK) }
      const part = await $fetch<ImportSummary>(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/comments/import`, {
        method: 'POST',
        body: chunk,
      })
      summary.received += part.received
      summary.mapped += part.mapped
      summary.inserted += part.inserted
      summary.skippedExisting += part.skippedExisting
      summary.unmapped.push(...part.unmapped)
      summary.orphanCount = part.orphanCount
      summary.threadsClosed += part.threadsClosed
    }
    importResult.value = summary
    toast.success(t('comments.import_success'))
  }
  catch (error) {
    importError.value = error instanceof Error && error.message === 'format'
      ? t('comments.import_format_error')
      : t('comments.import_error')
    toast.error(importError.value)
  }
  finally {
    importing.value = false
    input.value = ''
  }
}
</script>

<template>
  <div class="space-y-6 p-5">
    <!-- Section: Enable -->
    <section>
      <div class="flex items-start gap-3">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-900/20">
          <span class="icon-[annon--comments] size-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
        </div>
        <div class="flex-1">
          <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
            {{ t('comments.config_title') }}
          </h4>
          <p class="mt-0.5 text-xs text-muted">
            {{ t('comments.config_description') }}
          </p>
        </div>
      </div>

      <div class="mt-4 space-y-3 pl-11">
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm text-heading dark:text-secondary-100">{{ t('comments.enabled') }}</span>
            <p class="text-xs text-muted">
              {{ t('comments.enabled_description') }}
            </p>
          </div>
          <AtomsFormSwitch :model-value="enabled" :disabled="!editable" @update:model-value="enabled = $event" />
        </div>

        <div v-if="enabled" class="rounded-lg border border-secondary-200 bg-secondary-50 px-3 py-2 dark:border-secondary-800 dark:bg-secondary-900">
          <p class="text-xs text-muted">
            {{ t('comments.endpoint_hint') }}
          </p>
          <code class="mt-1 block truncate font-mono text-xs text-body dark:text-secondary-300">{{ publicEndpoint }}</code>
        </div>
      </div>
    </section>

    <!-- Section: Moderation -->
    <section v-if="enabled">
      <div class="flex items-start gap-3">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success-50 dark:bg-success-900/20">
          <span class="icon-[annon--shield-check] size-4 text-success-600 dark:text-success-400" aria-hidden="true" />
        </div>
        <div class="flex-1">
          <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
            {{ t('comments.moderation_title') }}
          </h4>
        </div>
      </div>

      <div class="mt-3 space-y-4 pl-11">
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm text-heading dark:text-secondary-100">{{ t('comments.require_approval') }}</span>
            <p class="text-xs text-muted">
              {{ t('comments.require_approval_description') }}
            </p>
          </div>
          <AtomsFormSwitch :model-value="requireApproval" :disabled="!editable" @update:model-value="requireApproval = $event" />
        </div>

        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm text-heading dark:text-secondary-100">{{ t('comments.require_email') }}</span>
            <p class="text-xs text-muted">
              {{ t('comments.require_email_description') }}
            </p>
          </div>
          <AtomsFormSwitch :model-value="requireEmail" :disabled="!editable" @update:model-value="requireEmail = $event" />
        </div>

        <div>
          <AtomsFormLabel for="comments-max-depth">
            {{ t('comments.max_depth') }}
          </AtomsFormLabel>
          <p class="mb-1.5 text-xs text-muted">
            {{ t('comments.max_depth_description') }}
          </p>
          <AtomsFormInput
            id="comments-max-depth"
            type="number"
            :model-value="String(maxDepth)"
            :disabled="!editable"
            @update:model-value="maxDepth = Math.max(0, Math.min(10, Number($event) || 0))"
          />
        </div>

        <div>
          <AtomsFormLabel for="comments-max-body">
            {{ t('comments.max_body_length') }}
          </AtomsFormLabel>
          <AtomsFormInput
            id="comments-max-body"
            type="number"
            :model-value="String(maxBodyLength)"
            :disabled="!editable"
            @update:model-value="maxBodyLength = Math.max(100, Math.min(20000, Number($event) || 5000))"
          />
        </div>
      </div>
    </section>

    <!-- Section: Security -->
    <section v-if="enabled">
      <div class="flex items-start gap-3">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning-50 dark:bg-warning-900/20">
          <span class="icon-[annon--shield-check] size-4 text-warning-600 dark:text-warning-400" aria-hidden="true" />
        </div>
        <div class="flex-1">
          <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
            {{ t('comments.security_title') }}
          </h4>
        </div>
      </div>

      <div class="mt-3 space-y-4 pl-11">
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm text-heading dark:text-secondary-100">{{ t('comments.honeypot') }}</span>
            <p class="text-xs text-muted">
              {{ t('comments.honeypot_description') }}
            </p>
          </div>
          <AtomsFormSwitch :model-value="honeypot" :disabled="!editable" @update:model-value="honeypot = $event" />
        </div>

        <div class="flex items-center justify-between">
          <span class="text-sm text-heading dark:text-secondary-100">{{ t('comments.captcha') }}</span>
          <div :class="{ 'pointer-events-none opacity-50': !editable }">
            <AtomsFormSelect
              :model-value="captcha || 'none'"
              :options="[
                { value: 'none', label: t('forms.captcha_none') },
                { value: 'turnstile', label: t('forms.captcha_turnstile') },
              ]"
              size="sm"
              @update:model-value="captcha = ($event === 'turnstile' ? 'turnstile' : '')"
            />
          </div>
        </div>

        <div>
          <AtomsFormLabel for="comments-rate-limit">
            {{ t('comments.rate_limit') }}
          </AtomsFormLabel>
          <p class="mb-1.5 text-xs text-muted">
            {{ t('comments.rate_limit_description') }}
          </p>
          <AtomsFormInput
            id="comments-rate-limit"
            type="number"
            :model-value="String(rateLimitPerIp)"
            :disabled="!editable"
            @update:model-value="rateLimitPerIp = Math.max(1, Math.min(60, Number($event) || 5))"
          />
        </div>
      </div>
    </section>

    <!-- Section: WordPress import -->
    <section v-if="enabled && editable">
      <div class="flex items-start gap-3">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info-50 dark:bg-info-900/20">
          <span class="icon-[annon--import] size-4 text-info-600 dark:text-info-400" aria-hidden="true" />
        </div>
        <div class="flex-1">
          <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
            {{ t('comments.import_title') }}
          </h4>
          <p class="mt-0.5 text-xs text-muted">
            {{ t('comments.import_description') }}
          </p>
        </div>
      </div>

      <div class="mt-3 space-y-3 pl-11">
        <input
          ref="importInput"
          type="file"
          accept="application/json,.json"
          class="sr-only"
          :aria-label="t('comments.import_button')"
          @change="onImportFile"
        >
        <AtomsBaseButton type="button" variant="secondary" size="sm" :disabled="importing" @click="importInput?.click()">
          <template #prepend>
            <span class="icon-[annon--import] size-3.5" aria-hidden="true" />
          </template>
          {{ importing ? t('common.loading') : t('comments.import_button') }}
        </AtomsBaseButton>

        <p v-if="importError" class="text-xs text-danger-500" role="alert">
          {{ importError }}
        </p>

        <div v-if="importResult" class="rounded-lg border border-secondary-200 bg-secondary-50 px-3 py-2 text-xs text-body dark:border-secondary-800 dark:bg-secondary-900 dark:text-secondary-300">
          <p>{{ t('comments.import_result', { received: importResult.received, inserted: importResult.inserted, skipped: importResult.skippedExisting, threads: importResult.threadsClosed }) }}</p>
          <p v-if="importResult.unmapped.length > 0" class="mt-1 text-warning-600 dark:text-warning-400">
            {{ t('comments.import_unmapped', { count: importResult.unmapped.length }) }}
          </p>
          <p v-if="importResult.orphanCount > 0" class="mt-1 text-warning-600 dark:text-warning-400">
            {{ t('comments.import_orphans', { count: importResult.orphanCount }) }}
          </p>
        </div>
      </div>
    </section>

    <!-- Save -->
    <div v-if="editable" class="flex items-center justify-end gap-2 border-t border-secondary-200 pt-4 dark:border-secondary-800">
      <AtomsBaseButton type="button" variant="primary" size="sm" :disabled="!hasChanges || saving" @click="save">
        {{ saving ? t('common.loading') : t('common.save') }}
      </AtomsBaseButton>
    </div>
  </div>
</template>
