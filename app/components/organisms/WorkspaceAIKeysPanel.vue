<script setup lang="ts">
defineProps<{
  workspaceId: string
}>()

const { activeWorkspace } = useWorkspaces()
const { t } = useContent()
const toast = useToast()

interface AIKeyInfo { id: string, provider: string, key_hint: string | null, created_at: string }
const aiKeys = ref<AIKeyInfo[]>([])
const aiKeyInput = ref('')
const aiKeySaving = ref(false)
// Load keys on mount
onMounted(async () => {
  if (!activeWorkspace.value) return
  try {
    aiKeys.value = await $fetch<AIKeyInfo[]>(`/api/workspaces/${activeWorkspace.value.id}/ai-keys`)
  }
  catch { aiKeys.value = [] }
})

async function handleSaveAIKey() {
  if (!activeWorkspace.value || !aiKeyInput.value.trim()) return
  aiKeySaving.value = true
  try {
    const saved = await $fetch<AIKeyInfo>(`/api/workspaces/${activeWorkspace.value.id}/ai-keys`, {
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
  if (!activeWorkspace.value) return
  try {
    await $fetch(`/api/workspaces/${activeWorkspace.value.id}/ai-keys/${keyId}`, { method: 'DELETE' })
    aiKeys.value = aiKeys.value.filter(k => k.id !== keyId)
    toast.success(t('ai_keys.delete_success'))
  }
  catch {
    toast.error(t('ai_keys.save_error'))
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
        <AtomsIconButton icon="icon-[annon--trash]" label="Delete" size="sm" @click="handleDeleteAIKey(key.id)" />
      </li>
    </ul>
    <div v-else-if="canByoa">
      <AtomsEmptyState icon="icon-[annon--key]" :title="t('ai_keys.no_keys')" :description="t('ai_keys.no_keys_description')" />
    </div>

    <!-- Add key form -->
    <form v-if="canByoa" class="space-y-3" @submit.prevent="handleSaveAIKey">
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
  </div>
</template>
