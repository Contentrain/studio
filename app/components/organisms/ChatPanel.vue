<script setup lang="ts">
import type { ChatUIContext, AffectedResources } from '~/composables/useChat'

const props = defineProps<{
  workspaceId: string
  projectId: string
  projectName: string
  projectStatus?: string
  context?: ChatUIContext
}>()

const emit = defineEmits<{
  contentChanged: [affected: AffectedResources]
}>()

const { t } = useContent()
const { messages, isStreaming, error, sendMessage, clearChat } = useChat({
  onContentChanged: (affected) => {
    emit('contentChanged', affected)
  },
})
const { toContextItems } = useChatContext()
const toast = useToast()
const messagesEndRef = ref<HTMLElement | null>(null)

async function handleSend(text: string) {
  // Merge explicit context items into the UI context
  const contextItems = toContextItems()
  const enrichedContext = props.context
    ? { ...props.context, contextItems }
    : undefined
  await sendMessage(props.workspaceId, props.projectId, text, enrichedContext as ChatUIContext)
}

defineExpose({ handleSend })

// Auto-scroll to bottom on new messages
watch(
  () => messages.value.length,
  () => {
    nextTick(() => {
      messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' })
    })
  },
)

// Show error toast
watch(error, (err) => {
  if (err) toast.error(err)
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div
      class="flex h-14 shrink-0 items-center justify-between border-b border-secondary-200 px-5 dark:border-secondary-800"
    >
      <h2 class="truncate text-sm font-semibold text-heading dark:text-secondary-100">
        {{ projectName }}
      </h2>
      <AtomsIconButton
        v-if="messages.length > 0" icon="icon-[annon--plus-circle]" :label="t('chat.new_conversation')"
        @click="clearChat"
      />
    </div>

    <!-- Messages -->
    <div class="flex-1 overflow-y-auto">
      <!-- Empty state: setup project (no .contentrain/) -->
      <div v-if="messages.length === 0 && projectStatus === 'setup'" class="flex h-full flex-col items-center justify-center gap-4 p-8">
        <AtomsEmptyState
          icon="icon-[annon--box]"
          :title="t('content.not_found_title')"
          :description="t('content.not_found_description')"
        />
        <AtomsBaseButton
          variant="primary"
          size="md"
          @click="handleSend(t('chat.init_prompt'))"
        >
          <template #prepend>
            <span class="icon-[annon--arrow-top] size-4" aria-hidden="true" />
          </template>
          <span>{{ t('chat.init_project') }}</span>
        </AtomsBaseButton>
      </div>

      <!-- Empty state: active project -->
      <div v-else-if="messages.length === 0" class="flex h-full items-center justify-center p-8">
        <AtomsEmptyState
          icon="icon-[annon--comment-2-plus]"
          :title="t('chat.empty_title')"
          :description="t('chat.empty_description')"
        />
      </div>

      <!-- Message list -->
      <div v-else class="space-y-4 p-4">
        <div v-for="msg in messages" :key="msg.id">
          <!-- Chat bubble -->
          <AtomsChatBubble v-if="msg.text" :role="msg.role" :text="msg.text" />

          <!-- Tool calls -->
          <div v-if="msg.toolCalls.length > 0" class="mt-2 space-y-2" :class="msg.role === 'user' ? 'ml-10' : 'ml-10'">
            <AtomsToolCallCard
              v-for="tc in msg.toolCalls" :key="tc.id" :name="tc.name" :input="tc.input"
              :result="tc.result" :status="tc.status"
            />
          </div>
        </div>

        <!-- Streaming indicator -->
        <div v-if="isStreaming" class="ml-10 flex items-center gap-2 text-xs text-muted">
          <div
            class="size-3 animate-spin rounded-full border-2 border-secondary-300 border-t-primary-500 dark:border-secondary-600 dark:border-t-primary-400"
          />
          <span>{{ t('chat.thinking') }}</span>
        </div>

        <!-- Scroll anchor -->
        <div ref="messagesEndRef" />
      </div>
    </div>

    <!-- Context bar (pinned items + drop zone) -->
    <MoleculesChatContextBar />

    <!-- Input -->
    <MoleculesChatInput :disabled="isStreaming" @send="handleSend" />
  </div>
</template>
