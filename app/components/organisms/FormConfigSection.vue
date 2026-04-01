<script setup lang="ts">
import type { FieldDef } from '@contentrain/types'
import { CheckboxIndicator, CheckboxRoot } from 'radix-vue'

const props = defineProps<{
  workspaceId: string
  projectId: string
  modelId: string
  editable?: boolean
}>()

const { t } = useContent()
const toast = useToast()
const brain = useContentBrain()
const { activeWorkspace } = useWorkspaces()

const plan = computed(() => activeWorkspace.value?.plan ?? 'free')
const canCaptcha = computed(() => hasFeature(plan.value, 'forms.captcha'))
const canAutoApprove = computed(() => hasFeature(plan.value, 'forms.auto_approve'))

// Current model from brain cache
const model = computed(() =>
  brain.models.value.find(m => m.id === props.modelId),
)

const modelFields = computed<Record<string, FieldDef>>(() =>
  (model.value?.fields ?? {}) as Record<string, FieldDef>,
)

// Current form config from model
const currentFormConfig = computed(() => {
  if (!model.value) return null
  return (model.value as unknown as { form?: Record<string, unknown> }).form ?? null
})

// Local form state
const enabled = ref(false)
const isPublic = ref(false)
const exposedFields = ref<string[]>([])
const honeypot = ref(false)
const captcha = ref<'turnstile' | ''>('')
const autoApprove = ref(false)
const successMessage = ref('')
const rateLimitPerIp = ref(10)

// Sync from brain when model/config changes
function syncFromBrain() {
  const cfg = currentFormConfig.value
  enabled.value = (cfg?.enabled as boolean) ?? false
  isPublic.value = (cfg?.public as boolean) ?? false
  exposedFields.value = [...((cfg?.exposedFields as string[]) ?? [])]
  honeypot.value = (cfg?.honeypot as boolean) ?? false
  captcha.value = (cfg?.captcha as string as 'turnstile' | '') ?? ''
  autoApprove.value = (cfg?.autoApprove as boolean) ?? false
  successMessage.value = (cfg?.successMessage as string) ?? ''
  rateLimitPerIp.value = ((cfg?.limits as Record<string, unknown>)?.rateLimitPerIp as number) ?? 10
}

watch(() => props.modelId, syncFromBrain, { immediate: true })
watch(currentFormConfig, syncFromBrain)

// Sorted field list for checkboxes
const sortedFieldIds = computed(() =>
  Object.keys(modelFields.value).sort(),
)

function toggleField(fieldId: string) {
  const idx = exposedFields.value.indexOf(fieldId)
  if (idx >= 0) {
    exposedFields.value.splice(idx, 1)
  }
  else {
    exposedFields.value.push(fieldId)
  }
}

function selectAllFields() {
  exposedFields.value = [...sortedFieldIds.value]
}

function clearAllFields() {
  exposedFields.value = []
}

// Has changes
const hasChanges = computed(() => {
  const cfg = currentFormConfig.value
  if (!cfg) return enabled.value
  return enabled.value !== ((cfg.enabled as boolean) ?? false)
    || isPublic.value !== ((cfg.public as boolean) ?? false)
    || JSON.stringify([...exposedFields.value].sort()) !== JSON.stringify([...((cfg.exposedFields as string[]) ?? [])].sort())
    || honeypot.value !== ((cfg.honeypot as boolean) ?? false)
    || (captcha.value || null) !== ((cfg.captcha as string) || null)
    || autoApprove.value !== ((cfg.autoApprove as boolean) ?? false)
    || successMessage.value !== ((cfg.successMessage as string) ?? '')
    || rateLimitPerIp.value !== (((cfg.limits as Record<string, unknown>)?.rateLimitPerIp as number) ?? 10)
})

// Validation
const validationError = computed(() => {
  if (enabled.value && exposedFields.value.length === 0) {
    return t('forms.no_fields_selected')
  }
  return null
})

// Save
const saving = ref(false)

async function save() {
  if (validationError.value || !hasChanges.value) return
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/models/${props.modelId}`, {
      method: 'PATCH',
      body: {
        form: {
          enabled: enabled.value,
          public: isPublic.value,
          exposedFields: exposedFields.value,
          honeypot: honeypot.value,
          captcha: captcha.value || null,
          autoApprove: autoApprove.value,
          successMessage: successMessage.value || undefined,
          limits: rateLimitPerIp.value !== 10
            ? { rateLimitPerIp: rateLimitPerIp.value }
            : undefined,
        },
      },
    })
    toast.success(t('forms.save_success'))
    // Re-sync brain to pick up changes
    await brain.sync(props.workspaceId, props.projectId)
  }
  catch {
    toast.error(t('forms.save_error'))
  }
  finally {
    saving.value = false
  }
}

function getFieldTypeBadge(type: string): string {
  const map: Record<string, string> = {
    string: 'Abc',
    number: '#',
    boolean: '0/1',
    date: 'Date',
    email: '@',
    url: 'URL',
    slug: 'slug',
    color: 'Color',
    richtext: 'Rich',
    markdown: 'MD',
    media: 'File',
    relation: 'Ref',
    json: 'JSON',
    select: 'List',
    array: '[ ]',
  }
  return map[type] ?? type
}
</script>

<template>
  <div class="space-y-6 p-5">
    <!-- Section: Enable Form -->
    <section>
      <div class="flex items-start gap-3">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-900/20">
          <span class="icon-[annon--note-2] size-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
        </div>
        <div class="flex-1">
          <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
            {{ t('forms.config_title') }}
          </h4>
          <p class="mt-0.5 text-xs text-muted">
            {{ t('forms.config_description') }}
          </p>
        </div>
      </div>

      <div class="mt-4 space-y-3 pl-11">
        <!-- Enabled toggle -->
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm text-heading dark:text-secondary-100">{{ t('forms.enabled') }}</span>
            <p class="text-xs text-muted">
              {{ t('forms.enabled_description') }}
            </p>
          </div>
          <AtomsFormSwitch :model-value="enabled" :disabled="!editable" @update:model-value="enabled = $event" />
        </div>

        <!-- Public toggle (only when enabled) -->
        <div v-if="enabled" class="flex items-center justify-between">
          <div>
            <span class="text-sm text-heading dark:text-secondary-100">{{ t('forms.public') }}</span>
            <p class="text-xs text-muted">
              {{ t('forms.public_description') }}
            </p>
          </div>
          <AtomsFormSwitch :model-value="isPublic" :disabled="!editable" @update:model-value="isPublic = $event" />
        </div>
      </div>
    </section>

    <!-- Section: Exposed Fields (only when enabled) -->
    <section v-if="enabled">
      <div class="flex items-start gap-3">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info-50 dark:bg-info-900/20">
          <span class="icon-[annon--task-square] size-4 text-info-600 dark:text-info-400" aria-hidden="true" />
        </div>
        <div class="flex-1">
          <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
            {{ t('forms.exposed_fields') }}
          </h4>
          <p class="mt-0.5 text-xs text-muted">
            {{ t('forms.exposed_fields_description') }}
          </p>
        </div>
      </div>

      <div class="mt-3 pl-11">
        <!-- Select all / clear all -->
        <div class="mb-2 flex items-center gap-2">
          <button type="button" class="text-xs font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400" :disabled="!editable" @click="selectAllFields">
            Select all
          </button>
          <span class="text-xs text-muted">/</span>
          <button type="button" class="text-xs font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400" :disabled="!editable" @click="clearAllFields">
            Clear
          </button>
          <span class="ml-auto text-xs text-muted">{{ exposedFields.length }}/{{ sortedFieldIds.length }}</span>
        </div>

        <!-- Field checkboxes -->
        <div class="space-y-1.5 rounded-lg border border-secondary-200 p-3 dark:border-secondary-800">
          <label
            v-for="fieldId in sortedFieldIds" :key="fieldId"
            class="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-800/50"
            :class="{ 'opacity-50': !editable }"
          >
            <CheckboxRoot
              :checked="exposedFields.includes(fieldId)"
              :disabled="!editable"
              class="flex size-4 shrink-0 items-center justify-center rounded border border-secondary-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 data-[state=checked]:border-primary-600 data-[state=checked]:bg-primary-600 dark:border-secondary-600 dark:data-[state=checked]:border-primary-500 dark:data-[state=checked]:bg-primary-500"
              @update:checked="toggleField(fieldId)"
            >
              <CheckboxIndicator>
                <span class="icon-[annon--tick] block size-3 text-white" aria-hidden="true" />
              </CheckboxIndicator>
            </CheckboxRoot>
            <span class="flex-1 text-sm text-heading dark:text-secondary-100">{{ fieldId }}</span>
            <AtomsBadge variant="secondary" size="sm">
              {{ getFieldTypeBadge(modelFields[fieldId]?.type ?? 'string') }}
            </AtomsBadge>
            <span v-if="modelFields[fieldId]?.required" class="text-xs text-danger-500" aria-hidden="true">*</span>
          </label>
        </div>

        <!-- Validation error -->
        <p v-if="validationError" class="mt-1.5 text-xs text-danger-500">
          {{ validationError }}
        </p>
      </div>
    </section>

    <!-- Section: Security (only when enabled) -->
    <section v-if="enabled">
      <div class="flex items-start gap-3">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning-50 dark:bg-warning-900/20">
          <span class="icon-[annon--shield-tick] size-4 text-warning-600 dark:text-warning-400" aria-hidden="true" />
        </div>
        <div class="flex-1">
          <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
            {{ t('forms.security_title') }}
          </h4>
        </div>
      </div>

      <div class="mt-3 space-y-4 pl-11">
        <!-- Honeypot -->
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm text-heading dark:text-secondary-100">{{ t('forms.honeypot') }}</span>
            <p class="text-xs text-muted">
              {{ t('forms.honeypot_description') }}
            </p>
          </div>
          <AtomsFormSwitch :model-value="honeypot" :disabled="!editable" @update:model-value="honeypot = $event" />
        </div>

        <!-- CAPTCHA -->
        <div class="flex items-center justify-between">
          <div>
            <div class="flex items-center gap-1.5">
              <span class="text-sm text-heading dark:text-secondary-100">{{ t('forms.captcha') }}</span>
              <AtomsBadge v-if="!canCaptcha" variant="info" size="sm">
                {{ t('forms.pro_badge') }}
              </AtomsBadge>
            </div>
          </div>
          <div :class="{ 'pointer-events-none opacity-50': !editable || !canCaptcha }">
            <AtomsFormSelect
              :model-value="captcha || ''"
              :options="[
                { value: '', label: t('forms.captcha_none') },
                { value: 'turnstile', label: t('forms.captcha_turnstile') },
              ]"
              size="sm"
              @update:model-value="captcha = ($event as 'turnstile' | '')"
            />
          </div>
        </div>

        <!-- Rate limit -->
        <div>
          <AtomsFormLabel :for="'rate-limit'">
            {{ t('forms.rate_limit') }}
          </AtomsFormLabel>
          <p class="mb-1.5 text-xs text-muted">
            {{ t('forms.rate_limit_description') }}
          </p>
          <AtomsFormInput
            id="rate-limit"
            type="number"
            :model-value="String(rateLimitPerIp)"
            :disabled="!editable"
            @update:model-value="rateLimitPerIp = Math.max(1, Math.min(100, Number($event) || 10))"
          />
        </div>
      </div>
    </section>

    <!-- Section: Behavior (only when enabled) -->
    <section v-if="enabled">
      <div class="flex items-start gap-3">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success-50 dark:bg-success-900/20">
          <span class="icon-[annon--setting-2] size-4 text-success-600 dark:text-success-400" aria-hidden="true" />
        </div>
        <div class="flex-1">
          <h4 class="text-sm font-semibold text-heading dark:text-secondary-100">
            Behavior
          </h4>
        </div>
      </div>

      <div class="mt-3 space-y-4 pl-11">
        <!-- Auto-approve -->
        <div class="flex items-center justify-between">
          <div>
            <div class="flex items-center gap-1.5">
              <span class="text-sm text-heading dark:text-secondary-100">{{ t('forms.auto_approve') }}</span>
              <AtomsBadge v-if="!canAutoApprove" variant="info" size="sm">
                {{ t('forms.pro_badge') }}
              </AtomsBadge>
            </div>
            <p class="text-xs text-muted">
              {{ t('forms.auto_approve_description') }}
            </p>
          </div>
          <AtomsFormSwitch :model-value="autoApprove" :disabled="!editable || !canAutoApprove" @update:model-value="autoApprove = $event" />
        </div>

        <!-- Success message -->
        <div>
          <AtomsFormLabel :for="'success-msg'">
            {{ t('forms.success_message') }}
          </AtomsFormLabel>
          <p class="mb-1.5 text-xs text-muted">
            {{ t('forms.success_message_description') }}
          </p>
          <AtomsFormInput
            id="success-msg"
            :model-value="successMessage"
            :placeholder="t('forms.success_message_placeholder')"
            :disabled="!editable"
            @update:model-value="successMessage = $event"
          />
        </div>
      </div>
    </section>

    <!-- Save button -->
    <div v-if="editable" class="sticky bottom-0 border-t border-secondary-200 bg-white pt-4 dark:border-secondary-800 dark:bg-secondary-950">
      <AtomsBaseButton
        variant="primary"
        :disabled="!hasChanges || !!validationError || saving"
        @click="save"
      >
        <AtomsSpinner v-if="saving" class="size-4" />
        <template v-else>
          {{ t('common.save') }}
        </template>
      </AtomsBaseButton>
    </div>
  </div>
</template>
