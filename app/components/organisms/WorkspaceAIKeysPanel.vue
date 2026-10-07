<script setup lang="ts">
const props = defineProps<{
  workspaceId: string
  /** The plan does not include bring-your-own-key: show the upgrade call to action instead. */
  locked?: boolean
}>()

const { t } = useContent()
const toast = useToast()

interface AIKeyInfo { id: string, provider: string, key_hint: string | null, created_at: string }
const aiKeys = ref<AIKeyInfo[]>([])
const aiKeyInput = ref('')
const aiKeySaving = ref(false)

// Reload whenever the workspace changes (switching slugs reuses this panel).
watch(
  () => [props.workspaceId, props.locked] as const,
  async ([workspaceId, locked], _previous, onCleanup) => {
    // A slow answer for the workspace we left must not overwrite the list of the one we are on.
    let stale = false
    onCleanup(() => {
      stale = true
    })
    aiKeys.value = []
    if (!workspaceId || locked) return
    try {
      const keys = await $fetch<AIKeyInfo[]>(`/api/workspaces/${workspaceId}/ai-keys`)
      if (!stale) aiKeys.value = keys
    }
    catch {
      if (!stale) aiKeys.value = []
    }
  },
  { immediate: true },
)

async function handleSaveAIKey() {
  if (!aiKeyInput.value.trim()) return
  aiKeySaving.value = true
  try {
    const saved = await $fetch<AIKeyInfo>(`/api/workspaces/${props.workspaceId}/ai-keys`, {
      method: 'POST',
      body: { provider: 'anthropic', apiKey: aiKeyInput.value.trim() },
    })
    aiKeys.value = aiKeys.value.filter(k => k.provider !== 'anthropic')
    aiKeys.value.push(saved)
    aiKeyInput.value = ''
    toast.success(t('ai_keys.save_success'))
  }
  catch {
    toast.error(t('ai_keys.save_error'))
  }
  finally {
    aiKeySaving.value = false
  }
}

async function handleDeleteAIKey(keyId: string) {
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/ai-keys/${keyId}`, { method: 'DELETE' })
    aiKeys.value = aiKeys.value.filter(k => k.id !== keyId)
    toast.success(t('ai_keys.delete_success'))
  }
  catch {
    toast.error(t('ai_keys.delete_error'))
  }
}
</script>

<template>
  <div class="max-w-md space-y-5">
    <div>
      <AtomsHeadingText :level="3" size="xs">
        {{ t('ai_keys.title') }}
      </AtomsHeadingText>
      <p class="mt-1 text-sm text-muted">
        {{ t('ai_keys.description') }}
      </p>
    </div>

    <div v-if="locked" class="rounded-lg border border-warning-200 bg-warning-50 p-4 dark:border-warning-800 dark:bg-warning-900/20" data-testid="ai-keys-locked">
      <p class="text-sm text-warning-800 dark:text-warning-200">
        {{ t('ai_keys.upgrade_cta', { plans: useFeaturePlans('ai.byoa') }) }}
      </p>
    </div>

    <template v-else>
      <!-- Existing keys -->
      <ul
        v-if="aiKeys.length > 0"
        class="divide-y divide-secondary-100 rounded-lg border border-secondary-200 dark:divide-secondary-800 dark:border-secondary-800"
      >
        <li v-for="key in aiKeys" :key="key.id" class="flex items-center gap-3 px-4 py-3">
          <span class="icon-[annon--key] size-4 text-muted" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-heading dark:text-secondary-100">
              {{ key.provider }}
            </div>
            <div v-if="key.key_hint" class="text-xs text-muted">
              {{ t('ai_keys.hint') }} {{ key.key_hint }}
            </div>
          </div>
          <AtomsIconButton icon="icon-[annon--trash]" :label="t('common.delete')" size="sm" @click="handleDeleteAIKey(key.id)" />
        </li>
      </ul>
      <div v-else>
        <AtomsEmptyState icon="icon-[annon--key]" :title="t('ai_keys.no_keys')" :description="t('ai_keys.no_keys_description')" />
      </div>

      <!-- Add key form -->
      <form class="space-y-3" @submit.prevent="handleSaveAIKey">
        <div>
          <div class="flex items-center gap-1">
            <AtomsFormLabel :text="t('ai_keys.provider')" size="sm" />
            <AtomsInfoTooltip :text="t('ai_keys.provider_info')" />
          </div>
          <AtomsBadge variant="secondary" size="md" class="mt-1.5">
            Anthropic
          </AtomsBadge>
        </div>
        <div>
          <div class="flex items-center gap-1">
            <AtomsFormLabel for="ai-key" :text="t('ai_keys.add_key')" size="sm" />
            <AtomsInfoTooltip :text="t('ai_keys.key_info')" />
          </div>
          <AtomsFormInput
            id="ai-key"
            v-model="aiKeyInput"
            type="password"
            :placeholder="t('ai_keys.placeholder')"
            class="mt-1.5"
          />
        </div>
        <AtomsBaseButton type="submit" variant="primary" size="md" :disabled="!aiKeyInput.trim() || aiKeySaving">
          {{ aiKeySaving ? t('ai_keys.saving') : t('ai_keys.add_key') }}
        </AtomsBaseButton>
      </form>
    </template>
  </div>
</template>
