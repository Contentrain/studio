<script setup lang="ts">
defineProps<{
  workspaceId: string
  projectId: string
}>()

const { t } = useContent()

// One gating rule: hidden when the feature is ee-backed and this is Community Edition,
// otherwise shown, with an upgrade call to action when the plan does not include it.
const mcpGate = useFeatureGate('api.mcp_cloud')
const conversationGate = useFeatureGate('api.conversation')
</script>

<template>
  <div class="space-y-8 px-6 py-5">
    <p class="text-xs text-muted">
      {{ t('project_settings.api_keys_description') }}
    </p>

    <template v-if="mcpGate !== 'hidden'">
      <OrganismsProjectMcpKeysPanel v-if="mcpGate === 'enabled'" :workspace-id="workspaceId" :project-id="projectId" />
      <section v-else data-testid="mcp-keys-locked">
        <h3 class="text-sm font-semibold text-heading dark:text-secondary-100">
          {{ t('mcp_cloud.section_title') }}
        </h3>
        <div class="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-4 dark:border-warning-800 dark:bg-warning-900/20">
          <p class="text-sm text-warning-800 dark:text-warning-200">
            {{ t('mcp_cloud.upgrade_cta', { plans: useFeaturePlans('api.mcp_cloud') }) }}
          </p>
        </div>
      </section>
    </template>

    <template v-if="conversationGate !== 'hidden'">
      <section data-testid="conversation-keys-section">
        <OrganismsConversationKeysPanel
          v-if="conversationGate === 'enabled'"
          :workspace-id="workspaceId"
          :project-id="projectId"
          embedded
        />
        <div v-else data-testid="conversation-keys-locked">
          <h3 class="text-sm font-semibold text-heading dark:text-secondary-100">
            {{ t('conversation_keys.section_title') }}
          </h3>
          <div class="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-4 dark:border-warning-800 dark:bg-warning-900/20">
            <p class="text-sm text-warning-800 dark:text-warning-200">
              {{ t('conversation_keys.upgrade_cta', { plans: useFeaturePlans('api.conversation') }) }}
            </p>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
