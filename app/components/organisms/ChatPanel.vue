<script setup lang="ts">
import type { ChatUIContext, AffectedResources } from '~/composables/useChat'
import { AI_MODELS } from '~/composables/useChat'
import { PopoverArrow, PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'radix-vue'

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
const { messages, conversationId, conversations, isStreaming, error, selectedModel, sendMessage, clearChat, fetchConversations, loadConversation, deleteConversation } = useChat({
  onContentChanged: (affected) => {
    emit('contentChanged', affected)
  },
})
const { chips, toContextItems, clear: clearContext } = useChatContext()
const { state: authState } = useAuth()
const toast = useToast()
const messagesEndRef = ref<HTMLElement | null>(null)
const historyOpen = ref(false)
const confirmDeleteId = ref<string | null>(null)

async function handleSend(text: string) {
  // Capture chips before clearing
  const contextItems = toContextItems()
  const attachedChips = chips.value.map(c => ({ type: c.type, label: c.label, sublabel: c.sublabel }))

  // Merge explicit context items into the UI context
  const enrichedContext = props.context
    ? { ...props.context, contextItems }
    : undefined

  // Clear context chips — they're now attached to the message
  if (attachedChips.length > 0) {
    clearContext()
  }

  await sendMessage(props.workspaceId, props.projectId, text, enrichedContext as ChatUIContext, attachedChips)
}

defineExpose({ handleSend })

// Clear chat when project changes + load conversations
watch(() => props.projectId, () => {
  clearChat()
  clearContext()
  fetchConversations(props.workspaceId, props.projectId)
}, { immediate: true })

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

function handleNewConversation() {
  clearChat()
  clearContext()
}

async function handleLoadConversation(convId: string) {
  historyOpen.value = false
  await loadConversation(props.workspaceId, props.projectId, convId)
}

async function handleDeleteConversation(convId: string) {
  if (confirmDeleteId.value !== convId) {
    confirmDeleteId.value = convId
    return
  }
  confirmDeleteId.value = null
  await deleteConversation(props.workspaceId, props.projectId, convId)
}

function formatConversationDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)

  if (diffMin < 60) return t('time.minutes_ago').replace('{count}', String(Math.max(1, diffMin)))
  if (diffHour < 24) return t('time.hours_ago').replace('{count}', String(diffHour))
  return t('time.days_ago').replace('{count}', String(diffDay))
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div
      class="flex h-14 shrink-0 items-center gap-2 border-b border-secondary-200 px-4 dark:border-secondary-800"
    >
      <!-- Conversation history popover -->
      <PopoverRoot v-model:open="historyOpen">
        <PopoverTrigger
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-heading transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-secondary-100 dark:hover:bg-secondary-900"
        >
          <span class="icon-[annon--comment-2] size-4 shrink-0 text-muted" aria-hidden="true" />
          <span class="truncate">{{ t('chat.title') }}</span>
          <span class="icon-[annon--chevron-down] size-3 shrink-0 text-muted" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            :side-offset="8"
            align="start"
            class="z-50 w-72 rounded-xl border border-secondary-200 bg-white shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
          >
            <PopoverArrow class="fill-white dark:fill-secondary-950" />
            <div class="p-2">
              <div class="mb-1 flex items-center justify-between px-2 py-1">
                <span class="text-xs font-semibold uppercase tracking-wider text-muted">{{ t('chat.conversations') }}</span>
                <PopoverClose as-child>
                  <AtomsIconButton icon="icon-[annon--cross]" label="Close" size="sm" />
                </PopoverClose>
              </div>

              <!-- New conversation -->
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-primary-600 transition-colors hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400 dark:hover:bg-primary-900/20"
                @click="handleNewConversation(); historyOpen = false"
              >
                <span class="icon-[annon--plus-circle] size-4" aria-hidden="true" />
                {{ t('chat.new_conversation') }}
              </button>

              <!-- History list -->
              <div v-if="conversations.length > 0" class="mt-1 max-h-60 space-y-px overflow-y-auto">
                <div
                  v-for="conv in conversations"
                  :key="conv.id"
                  class="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900"
                  :class="conv.id === conversationId ? 'bg-secondary-50 dark:bg-secondary-900' : ''"
                >
                  <button
                    type="button"
                    class="min-w-0 flex-1 text-left focus-visible:outline-none"
                    @click="handleLoadConversation(conv.id)"
                  >
                    <div class="truncate text-sm text-heading dark:text-secondary-100">
                      {{ conv.title || t('chat.untitled') }}
                    </div>
                    <div class="text-[10px] text-muted">
                      {{ formatConversationDate(conv.updated_at) }}
                    </div>
                  </button>
                  <button
                    type="button"
                    class="shrink-0 rounded p-0.5 text-muted opacity-0 transition-all hover:text-danger-500 group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500/50"
                    :title="confirmDeleteId === conv.id ? t('chat.confirm_delete') : t('chat.delete_conversation')"
                    @click.stop="handleDeleteConversation(conv.id)"
                  >
                    <span class="icon-[annon--trash] block size-3" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <p v-else class="px-2 py-2 text-xs text-muted">
                {{ t('chat.no_conversations') }}
              </p>
            </div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>

      <div class="flex-1" />

      <!-- Model selector -->
      <AtomsFormSelect
        :model-value="selectedModel"
        :options="AI_MODELS.map(m => ({ value: m.id, label: m.label }))"
        size="sm"
        @update:model-value="selectedModel = $event"
      />

      <!-- New conversation (quick) -->
      <AtomsIconButton
        v-if="messages.length > 0"
        icon="icon-[annon--plus-circle]"
        :label="t('chat.new_conversation')"
        size="sm"
        @click="handleNewConversation"
      />
    </div>

    <!-- Messages -->
    <div class="flex-1 overflow-y-auto">
      <!-- Initial loading skeleton -->
      <div v-if="messages.length === 0 && !projectStatus" class="flex h-full flex-col items-center justify-center gap-3 p-8">
        <AtomsSkeleton variant="custom" class="size-12 rounded-full" />
        <AtomsSkeleton variant="custom" class="h-4 w-40 rounded" />
        <AtomsSkeleton variant="custom" class="h-3 w-56 rounded" />
      </div>

      <!-- Empty state: setup project (no .contentrain/) -->
      <div v-else-if="messages.length === 0 && projectStatus === 'setup'" class="flex h-full flex-col items-center justify-center p-8">
        <AtomsEmptyState
          illustration="/illustrations/initialize-project.png"
          :title="t('content.not_found_title')"
          :description="t('content.not_found_description')"
        >
          <template #action>
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
          </template>
        </AtomsEmptyState>
      </div>

      <!-- Empty state: active project -->
      <div v-else-if="messages.length === 0" class="flex h-full items-center justify-center p-8">
        <AtomsEmptyState
          illustration="/illustrations/start-conversation.png"
          :title="t('chat.empty_title')"
          :description="t('chat.empty_description')"
        />
      </div>

      <!-- Message list -->
      <div v-else class="space-y-4 p-4">
        <div v-for="msg in messages" :key="msg.id">
          <!-- Chat bubble -->
          <AtomsChatBubble
            v-if="msg.text"
            :role="msg.role"
            :text="msg.text"
            :user-avatar-url="authState.user?.avatarUrl"
            :user-name="authState.user?.email"
            :context-items="msg.contextItems"
          />

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
