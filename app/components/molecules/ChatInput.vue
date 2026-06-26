<script setup lang="ts">
import type { UIAttachment } from '~/composables/useChat'

const props = defineProps<{
  disabled?: boolean
  workspaceId: string
  projectId: string
}>()

const emit = defineEmits<{
  send: [text: string, attachments: UIAttachment[]]
}>()

const { t } = useContent()

const input = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const attachments = ref<UIAttachment[]>([])
const isDragOver = ref(false)

const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.csv,.tsv,.txt,.md,.markdown,.json,.docx,.xlsx,image/*,application/pdf'
const URL_RE = /^https?:\/\/\S+$/i

const hasUploading = computed(() => attachments.value.some(a => a.status === 'uploading'))
const canSend = computed(() => !!input.value.trim() && !props.disabled && !hasUploading.value)

interface ServerRef {
  id: string
  filename: string
  mime: string
  kind: 'text' | 'document' | 'image'
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
  att.blocks = ref.blocks
  att.preview = ref.preview
  att.truncated = ref.truncated
  att.previewUrl = previewFromBlocks(ref.blocks)
}

async function uploadFile(file: File) {
  const att: UIAttachment = reactive({
    id: `att-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    status: 'uploading',
    filename: file.name,
    kind: guessKind(file),
    mime: file.type || 'application/octet-stream',
  })
  attachments.value.push(att)
  try {
    const fd = new FormData()
    fd.append('file', file)
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

function handleFiles(files: FileList | File[] | null | undefined) {
  if (!files) return
  for (const file of Array.from(files)) void uploadFile(file)
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter(a => a.id !== id)
}

function onFilePicked(e: Event) {
  const target = e.target as HTMLInputElement
  handleFiles(target.files)
  target.value = '' // allow re-picking the same file
}

function onDrop(e: DragEvent) {
  isDragOver.value = false
  if (!e.dataTransfer?.types.includes('Files')) return // ignore context-chip drags
  e.preventDefault()
  handleFiles(e.dataTransfer.files)
}

function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  isDragOver.value = true
}

function onPaste(e: ClipboardEvent) {
  const dt = e.clipboardData
  if (!dt) return
  if (dt.files && dt.files.length > 0) {
    e.preventDefault()
    handleFiles(dt.files)
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
  <div
    class="border-t border-secondary-200 p-3 dark:border-secondary-800"
    :class="isDragOver ? 'bg-primary-50/60 dark:bg-primary-900/10' : ''"
    @drop="onDrop"
    @dragover="onDragOver"
    @dragleave="isDragOver = false"
  >
    <!-- Attachment tray -->
    <ul v-if="attachments.length > 0" class="mb-2 flex flex-wrap gap-2">
      <li
        v-for="att in attachments"
        :key="att.id"
        class="flex max-w-[220px] items-center gap-1.5 rounded-lg border px-2 py-1 text-xs"
        :class="att.status === 'error'
          ? 'border-danger-200 bg-error text-danger-600 dark:border-danger-500/30'
          : 'border-secondary-200 bg-secondary-50 text-body dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-300'"
      >
        <NuxtImg
          v-if="att.kind === 'image' && att.previewUrl && att.status === 'ready'"
          :src="att.previewUrl"
          alt=""
          class="size-6 shrink-0 rounded object-cover"
        />
        <span
          v-else-if="att.status === 'uploading'"
          class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-secondary-300 border-t-primary-500 dark:border-secondary-600 dark:border-t-primary-400"
          aria-hidden="true"
        />
        <span v-else :class="attachmentIcon(att)" class="size-3.5 shrink-0" aria-hidden="true" />

        <span class="truncate" :title="att.error || att.filename">{{ att.filename }}</span>
        <span v-if="att.truncated" class="shrink-0 text-[10px] text-warning-500" :title="t('chat.attachment_truncated')">✂</span>

        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-danger-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500/50"
          :aria-label="t('chat.attachment_remove')"
          @click="removeAttachment(att.id)"
        >
          <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <div class="flex items-end gap-2">
      <!-- Attach button -->
      <input
        ref="fileInputRef"
        type="file"
        multiple
        :accept="ACCEPT"
        class="hidden"
        @change="onFilePicked"
      >
      <AtomsBaseButton
        variant="ghost"
        size="md"
        :disabled="disabled"
        class="shrink-0 rounded-xl"
        :aria-label="t('chat.attach')"
        :title="t('chat.attach')"
        @click="fileInputRef?.click()"
      >
        <template #prepend>
          <span class="icon-[annon--cloud-upload] size-4" aria-hidden="true" />
        </template>
      </AtomsBaseButton>

      <textarea
        ref="textareaRef" v-model="input" :placeholder="t('chat.placeholder')" :disabled="disabled" rows="1"
        class="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-secondary-200 bg-white px-4 py-2.5 text-sm text-heading placeholder:text-muted focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
        @input="autoResize" @keydown="handleKeydown" @paste="onPaste"
      />
      <AtomsBaseButton
        variant="primary" size="md" :disabled="!canSend" class="shrink-0 rounded-xl"
        @click="handleSend"
      >
        <template #prepend>
          <span class="icon-[annon--arrow-top] size-4" aria-hidden="true" />
        </template>
        <span class="sr-only">{{ t('chat.send') }}</span>
      </AtomsBaseButton>
    </div>
  </div>
</template>
