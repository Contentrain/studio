<script setup lang="ts">
import type { UIAttachment } from '~/composables/useChat'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'radix-vue'

const props = defineProps<{
  disabled?: boolean
  /** True while the assistant is streaming — turns send into a stop button. */
  streaming?: boolean
  workspaceId: string
  projectId: string
}>()

const emit = defineEmits<{
  send: [text: string, attachments: UIAttachment[]]
  stop: []
}>()

const { t } = useContent()
// "Upload to media library" is an ee/media-gated capability; hidden otherwise.
const canUploadMedia = useFeature('media.upload')

const input = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const attachments = ref<UIAttachment[]>([])

// Which destination the next file picker is for (set before opening it).
const pendingIntent = ref<'context' | 'media'>('context')
const showLinkInput = ref(false)
const linkValue = ref('')

const ALL_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.csv,.tsv,.txt,.md,.markdown,.json,.docx,.xlsx,image/*,application/pdf'
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,image/*'
const pickerAccept = computed(() => pendingIntent.value === 'media' ? IMAGE_ACCEPT : ALL_ACCEPT)
const URL_RE = /^https?:\/\/\S+$/i

const hasUploading = computed(() => attachments.value.some(a => a.status === 'uploading'))
const canSend = computed(() => !!input.value.trim() && !props.disabled && !hasUploading.value)

interface ServerRef {
  id: string
  filename: string
  mime: string
  kind: 'text' | 'document' | 'image'
  destination?: 'context' | 'media'
  bytes?: number
  blocks: unknown[]
  preview?: string
  truncated?: boolean
  error?: string
}

function guessKind(file: File): UIAttachment['kind'] {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'document'
  return 'text'
}

function previewFromBlocks(blocks: unknown[]): string | undefined {
  const img = (blocks as Array<{ type?: string, source?: { type?: string, url?: string, mediaType?: string, data?: string } }>)
    .find(b => b?.type === 'image')
  if (!img?.source) return undefined
  return img.source.type === 'url'
    ? img.source.url
    : (img.source.type === 'base64' ? `data:${img.source.mediaType};base64,${img.source.data}` : undefined)
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function applyRef(att: UIAttachment, ref: ServerRef | undefined) {
  if (!ref) {
    att.status = 'error'
    att.error = t('chat.attachment_failed')
    return
  }
  if (ref.error) {
    att.status = 'error'
    att.error = ref.error
    return
  }
  att.status = 'ready'
  att.filename = ref.filename
  att.kind = ref.kind
  att.mime = ref.mime
  att.destination = ref.destination ?? att.destination
  att.bytes = ref.bytes
  att.blocks = ref.blocks
  att.preview = ref.preview
  att.truncated = ref.truncated
  att.previewUrl = previewFromBlocks(ref.blocks)
}

async function uploadFile(file: File, intent: 'context' | 'media') {
  const att: UIAttachment = reactive({
    id: `att-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    status: 'uploading',
    filename: file.name,
    kind: guessKind(file),
    mime: file.type || 'application/octet-stream',
    destination: intent,
  })
  attachments.value.push(att)
  try {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('intent', intent)
    const res = await $fetch<{ attachments: ServerRef[] }>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/attachments`,
      { method: 'POST', body: fd },
    )
    applyRef(att, res.attachments?.[0])
  }
  catch (e) {
    att.status = 'error'
    att.error = resolveApiError(e, t('chat.attachment_failed'))
  }
}

async function attachLink(url: string) {
  const att: UIAttachment = reactive({
    id: `att-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    status: 'uploading',
    filename: url,
    kind: 'text',
    mime: 'text/uri-list',
    destination: 'context',
  })
  attachments.value.push(att)
  try {
    const res = await $fetch<{ attachments: ServerRef[] }>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/attachments`,
      { method: 'POST', body: { url } },
    )
    applyRef(att, res.attachments?.[0])
  }
  catch (e) {
    att.status = 'error'
    att.error = resolveApiError(e, t('chat.attachment_failed'))
  }
}

function handleFiles(files: FileList | File[] | null | undefined, intent: 'context' | 'media' = 'context') {
  if (!files) return
  for (const file of Array.from(files)) void uploadFile(file, intent)
}

/** Exposed so the panel can forward panel-wide drag-drops (always context). */
function addFiles(files: FileList | File[] | null) {
  handleFiles(files, 'context')
}
defineExpose({ addFiles })

function openPicker(intent: 'context' | 'media') {
  pendingIntent.value = intent
  showLinkInput.value = false
  nextTick(() => fileInputRef.value?.click())
}

function openLinkInput() {
  showLinkInput.value = true
}

function submitLink() {
  const url = linkValue.value.trim()
  if (!url) return
  void attachLink(url)
  linkValue.value = ''
  showLinkInput.value = false
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter(a => a.id !== id)
}

function onFilePicked(e: Event) {
  const target = e.target as HTMLInputElement
  handleFiles(target.files, pendingIntent.value)
  target.value = '' // allow re-picking the same file
}

function onPaste(e: ClipboardEvent) {
  const dt = e.clipboardData
  if (!dt) return
  if (dt.files && dt.files.length > 0) {
    e.preventDefault()
    handleFiles(dt.files, 'context')
    return
  }
  // A clipboard whose entire text is a single URL → attach as a link.
  const text = dt.getData('text')?.trim()
  if (text && URL_RE.test(text)) {
    e.preventDefault()
    void attachLink(text)
  }
}

function attachmentIcon(att: UIAttachment): string {
  if (att.status === 'error') return 'icon-[annon--alert-circle]'
  if (att.kind === 'image') return 'icon-[annon--image-3]'
  if (att.mime === 'text/uri-list' || URL_RE.test(att.filename)) return 'icon-[annon--link-1]'
  return 'icon-[annon--file-text]'
}

function handleSend() {
  const text = input.value.trim()
  if (!text || props.disabled || hasUploading.value) return
  emit('send', text, attachments.value)
  input.value = ''
  attachments.value = []
  nextTick(() => autoResize())
}

function handleKeydown(e: KeyboardEvent) {
  // Enter sends, Shift+Enter adds newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}
</script>

<template>
  <div class="border-t border-secondary-200 p-3 dark:border-secondary-800">
    <!-- Attachment tray -->
    <ul v-if="attachments.length > 0" class="mb-2 flex flex-wrap gap-2">
      <li
        v-for="att in attachments" :key="att.id"
        class="flex max-w-60 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs"
        :class="att.status === 'error'
          ? 'border-danger-200 bg-error text-danger-600 dark:border-danger-500/30'
          : 'border-secondary-200 bg-secondary-50 text-body dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-300'"
      >
        <NuxtImg
          v-if="att.kind === 'image' && att.previewUrl && att.status === 'ready'" :src="att.previewUrl" alt=""
          class="size-7 shrink-0 rounded object-cover"
        />
        <span
          v-else-if="att.status === 'uploading'"
          class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-secondary-300 border-t-primary-500 dark:border-secondary-600 dark:border-t-primary-400"
          aria-hidden="true"
        />
        <span v-else :class="attachmentIcon(att)" class="size-3.5 shrink-0" aria-hidden="true" />

        <span class="truncate" :title="att.error || att.filename">{{ att.filename }}</span>

        <span v-if="att.bytes" class="shrink-0 text-[10px] text-muted">{{ formatBytes(att.bytes) }}</span>

        <!-- Destination badge — makes intent explicit for the user (and agent). -->
        <span
          v-if="att.status === 'ready'"
          class="shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide" :class="att.destination === 'media'
            ? 'bg-info-100 text-info-600 dark:bg-info-500/20 dark:text-info-300'
            : 'bg-secondary-200 text-secondary-600 dark:bg-secondary-700 dark:text-secondary-300'"
        >
          {{ att.destination === 'media' ? t('chat.dest_media') : t('chat.dest_context') }}
        </span>

        <span
          v-if="att.truncated" class="shrink-0 text-[10px] text-warning-500"
          :title="t('chat.attachment_truncated')"
        >✂</span>

        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500/50"
          :aria-label="t('chat.attachment_remove')" @click="removeAttachment(att.id)"
        >
          <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <!-- Link input row (toggled from the + menu) -->
    <div v-if="showLinkInput" class="mb-2 flex items-center gap-2">
      <AtomsFormInput
        v-model="linkValue" :placeholder="t('chat.attach_link_placeholder')"
        @keydown.enter.prevent="submitLink" @keydown.escape="showLinkInput = false"
      />
      <AtomsBaseButton size="sm" :disabled="!linkValue.trim()" @click="submitLink">
        <span>{{ t('common.add') }}</span>
      </AtomsBaseButton>
    </div>

    <div class="flex items-end gap-2">
      <!-- Hidden file input (accept set per pending intent) -->
      <input ref="fileInputRef" type="file" multiple :accept="pickerAccept" class="hidden" @change="onFilePicked">

      <!-- Attach (+) menu -->
      <DropdownMenuRoot>
        <DropdownMenuTrigger as-child>
          <button
            type="button" :disabled="disabled"
            class="flex size-9 shrink-0 items-center justify-center rounded-xl border border-secondary-200 text-muted transition-colors hover:bg-secondary-50 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-secondary-700 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
            :aria-label="t('chat.attach')"
          >
            <span class="icon-[annon--plus] size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            side="top" align="start" :side-offset="8"
            class="z-50 w-64 rounded-xl border border-secondary-200 bg-white p-1 shadow-xl dark:border-secondary-800 dark:bg-secondary-950"
          >
            <DropdownMenuItem
              class="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors data-highlighted:bg-secondary-50 dark:data-highlighted:bg-secondary-900"
              @select="openPicker('context')"
            >
              <span class="icon-[annon--file-text] mt-px size-4 shrink-0 text-muted" aria-hidden="true" />
              <span class="min-w-0">
                <span class="block font-medium text-heading dark:text-secondary-100">{{ t('chat.attach_context')
                }}</span>
                <span class="block text-xs text-muted">{{ t('chat.attach_context_desc') }}</span>
              </span>
            </DropdownMenuItem>

            <DropdownMenuItem
              v-if="canUploadMedia"
              class="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors data-highlighted:bg-secondary-50 dark:data-highlighted:bg-secondary-900"
              @select="openPicker('media')"
            >
              <span class="icon-[annon--image-3] mt-px size-4 shrink-0 text-info-500" aria-hidden="true" />
              <span class="min-w-0">
                <span class="block font-medium text-heading dark:text-secondary-100">{{ t('chat.attach_media')
                }}</span>
                <span class="block text-xs text-muted">{{ t('chat.attach_media_desc') }}</span>
              </span>
            </DropdownMenuItem>

            <DropdownMenuItem
              class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors data-highlighted:bg-secondary-50 dark:data-highlighted:bg-secondary-900"
              @select="openLinkInput"
            >
              <span class="icon-[annon--link-1] size-4 shrink-0 text-muted" aria-hidden="true" />
              <span class="font-medium text-heading dark:text-secondary-100">{{ t('chat.attach_link') }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <textarea
        ref="textareaRef" v-model="input" :placeholder="t('chat.placeholder')" :disabled="disabled" rows="1"
        class="max-h-40 min-h-9 flex-1 resize-none rounded-xl border border-secondary-200 bg-white px-4 py-2 text-sm text-heading placeholder:text-muted focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
        @input="autoResize" @keydown="handleKeydown" @paste="onPaste"
      />

      <!-- Stop (while streaming) / Send -->
      <button
        v-if="streaming" type="button"
        class="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary-200 text-heading transition-colors hover:bg-secondary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:bg-secondary-700 dark:text-secondary-100 dark:hover:bg-secondary-600"
        :aria-label="t('chat.stop')" @click="emit('stop')"
      >
        <span class="block size-2.5 rounded-[3px] bg-current" aria-hidden="true" />
      </button>
      <button
        v-else type="button"
        class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-600 text-white transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-primary-500 dark:hover:bg-primary-400"
        :disabled="!canSend" :aria-label="t('chat.send')" @click="handleSend"
      >
        <span class="icon-[annon--arrow-top] size-4" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
