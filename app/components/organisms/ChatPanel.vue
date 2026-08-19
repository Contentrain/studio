<script setup lang="ts">
import type { ChatUIContext, AffectedResources, UIAttachment } from '~/composables/useChat'
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
const { messages, conversationId, conversations, isStreaming, error, streamTick, sendMessage, stopStreaming, clearChat, fetchConversations, loadConversation, deleteConversation } = useChat({
  onContentChanged: (affected) => {
    emit('contentChanged', affected)
  },
})

/**
 * The welcome state of a ready project — the one empty branch that centres
 * itself with the composer. The loading skeleton and the setup state keep the
 * full column: setup carries its own "initialize project" call to action and
 * shouldn't compete with the composer for attention.
 */
const isEmptyActive = computed(() =>
  messages.value.length === 0 && !!props.projectStatus && props.projectStatus !== 'setup',
)

// Panel-wide drag-drop → forwarded to the composer (always as context).
// Accepts real files AND `text/uri-list` drags — an image dragged in from
// another browser tab carries no `Files` entry, only its URL; without the
// uri-list branch that drop navigated the page away with zero feedback.
const chatInputRef = ref<{ addFiles: (files: FileList | File[] | null) => void, attachLink: (url: string) => Promise<void> } | null>(null)
const isDragOver = ref(false)

function isAcceptedDrag(dt: DataTransfer | null): boolean {
  return !!dt && (dt.types.includes('Files') || dt.types.includes('text/uri-list'))
}

function onPanelDragOver(e: DragEvent) {
  if (!isAcceptedDrag(e.dataTransfer)) return // ignore context-chip drags
  e.preventDefault()
  isDragOver.value = true
}

function onPanelDragLeave(e: DragEvent) {
  const related = e.relatedTarget as Node | null
  if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
    isDragOver.value = false
  }
}

function onPanelDrop(e: DragEvent) {
  isDragOver.value = false
  const dt = e.dataTransfer
  if (!isAcceptedDrag(dt)) return
  e.preventDefault()
  if (dt!.files.length > 0) {
    chatInputRef.value?.addFiles(dt!.files)
    return
  }
  // uri-list: first non-comment line is the dragged resource's URL.
  const uri = dt!.getData('text/uri-list')
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#'))
  if (uri && /^https?:\/\//i.test(uri)) {
    void chatInputRef.value?.attachLink(uri)
  }
}
const { chips, toContextItems, clear: clearContext } = useChatContext()
const { state: authState } = useAuth()
const toast = useToast()
const messagesEndRef = ref<HTMLElement | null>(null)
const scrollContainerRef = ref<HTMLElement | null>(null)
const historyOpen = ref(false)
const confirmDeleteId = ref<string | null>(null)

// Scroll-follow: keep the view pinned to the bottom while a turn
// streams, but release the pin the moment the user scrolls up to read.
// Scrolling back near the bottom re-pins.
const PIN_THRESHOLD_PX = 96
const isPinned = ref(true)

function onMessagesScroll() {
  const el = scrollContainerRef.value
  if (!el) return
  isPinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX
}

async function handleSend(text: string, attachments?: UIAttachment[]) {
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

  await sendMessage(props.workspaceId, props.projectId, text, enrichedContext as ChatUIContext, attachedChips, attachments)
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

// Scroll-follow during streaming: every content-bearing SSE event bumps
// `streamTick`; while pinned, keep the anchor in view. `auto` (not
// `smooth`) so rapid deltas don't queue competing animations.
watch(streamTick, () => {
  if (!isPinned.value) return
  nextTick(() => {
    messagesEndRef.value?.scrollIntoView({ behavior: 'auto' })
  })
})

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
  <div
    class="relative flex h-full flex-col"
    @dragover="onPanelDragOver"
    @dragleave="onPanelDragLeave"
    @drop="onPanelDrop"
  >
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
                    class="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
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
                    class="shrink-0 rounded p-0.5 text-muted opacity-0 transition-[color,opacity] hover:text-danger-500 group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500/50"
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

      <!-- New conversation (quick) -->
      <AtomsIconButton
        v-if="messages.length > 0"
        icon="icon-[annon--plus-circle]"
        :label="t('chat.new_conversation')"
        size="sm"
        @click="handleNewConversation"
      />
    </div>

    <!-- Conversation column. On a fresh conversation the whole group — welcome
         state, context bar and composer — centres vertically; once there are
         messages the transcript takes the space and the composer sits at the
         bottom. The wrapper is required: centring on the panel root would drag
         the header down with it. -->
    <div class="flex min-h-0 flex-1 flex-col" :class="{ 'justify-center': isEmptyActive }">
      <!-- Messages -->
      <div
        ref="scrollContainerRef"
        class="overflow-y-auto"
        :class="isEmptyActive ? 'shrink-0' : 'min-h-0 flex-1'"
        @scroll.passive="onMessagesScroll"
      >
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

        <!-- Empty state: active project. No `h-full` — this branch is the one
           that centres with the composer, so its height comes from content. -->
        <div v-else-if="messages.length === 0" class="flex items-center justify-center p-8">
          <AtomsEmptyState
            illustration="/illustrations/start-conversation.png"
            :title="t('chat.empty_title')"
            :description="t('chat.empty_description')"
          />
        </div>

        <!-- Message list -->
        <div v-else class="space-y-4 p-4">
          <div v-for="msg in messages" :key="msg.id">
            <!-- User: bubble with context chips + attachments -->
            <AtomsChatBubble
              v-if="msg.role === 'user' && hasVisibleContent(msg)"
              role="user"
              :text="messageText(msg)"
              :user-avatar-url="authState.user?.avatarUrl"
              :user-name="authState.user?.email"
              :context-items="msg.contextItems"
              :attachments="msg.attachments"
            />

            <!-- Assistant: chronological narration/tool flow -->
            <div v-else-if="msg.role === 'assistant' && hasVisibleContent(msg)" class="flex gap-3">
              <div class="shrink-0 pt-0.5">
                <div class="flex size-7 items-center justify-center rounded-full bg-secondary-100 dark:bg-secondary-800">
                  <AtomsLogo variant="icon" color="auto" class="size-4" />
                </div>
              </div>
              <div class="min-w-0 max-w-[85%] flex-1 space-y-2">
                <template v-for="(seg, segIdx) in msg.segments" :key="seg.kind === 'tool' ? seg.call.id : `txt-${segIdx}`">
                  <div
                    v-if="seg.kind === 'text' && seg.text.trim()"
                    class="rounded-2xl bg-secondary-50 px-4 py-2.5 text-sm text-heading dark:bg-secondary-900 dark:text-secondary-100"
                  >
                    <AtomsChatMarkdown :text="seg.text" />
                  </div>
                  <AtomsToolCallCard
                    v-else-if="seg.kind === 'tool'"
                    :name="seg.call.name" :input="seg.call.input"
                    :result="seg.call.result" :status="seg.call.status"
                  />
                </template>
              </div>
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

      <!-- Limit reached banner -->
      <div
        v-if="error && error.includes('limit')"
        class="flex items-center gap-3 border-t border-warning-200 bg-warning-50 px-4 py-3 dark:border-warning-500/20 dark:bg-warning-500/10"
      >
        <NuxtImg src="/illustrations/limit-reached.png" alt="" class="h-10 w-auto shrink-0" loading="lazy" />
        <div class="min-w-0 flex-1">
          <p class="text-xs font-medium text-warning-700 dark:text-warning-400">
            {{ error }}
          </p>
        </div>
        <AtomsBadge variant="warning" size="sm">
          {{ t('common.upgrade') }}
        </AtomsBadge>
      </div>

      <!-- Context bar (pinned items + drop zone) -->
      <MoleculesChatContextBar />

      <!-- Input -->
      <MoleculesChatInput
        ref="chatInputRef"
        :disabled="!!error && error.includes('limit')"
        :streaming="isStreaming"
        :workspace-id="workspaceId"
        :project-id="projectId"
        @send="handleSend"
        @stop="stopStreaming"
      />
    </div>

    <!-- Panel-wide file drop overlay -->
    <div
      v-if="isDragOver"
      class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-primary-50/80 backdrop-blur-sm dark:bg-primary-950/70"
    >
      <div class="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary-400 px-8 py-6 text-primary-600 dark:border-primary-500 dark:text-primary-300">
        <span class="icon-[annon--cloud-upload] size-7" aria-hidden="true" />
        <span class="text-sm font-medium">{{ t('chat.drop_files') }}</span>
      </div>
    </div>
  </div>
</template>
