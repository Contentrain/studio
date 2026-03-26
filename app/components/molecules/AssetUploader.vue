<script setup lang="ts">
const { t } = useContent()

const emit = defineEmits<{
  uploaded: [asset: Record<string, unknown>]
  error: [message: string]
}>()

const props = defineProps<{
  workspaceId: string
  projectId: string
}>()

const isDragging = ref(false)
const isUploading = ref(false)
const progress = ref(0)
const currentFile = ref<string | null>(null)
const phase = ref<'idle' | 'uploading' | 'processing' | 'done' | 'error'>('idle')
const errorMessage = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

function handleDrop(e: DragEvent) {
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (files?.length) uploadFiles(Array.from(files))
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (files?.length) uploadFiles(Array.from(files))
  input.value = ''
}

function openFilePicker() {
  fileInput.value?.click()
}

async function uploadFiles(files: File[]) {
  for (const file of files) {
    await uploadSingleFile(file)
  }
}

function uploadSingleFile(file: File): Promise<void> {
  return new Promise((resolve) => {
    currentFile.value = file.name
    phase.value = 'uploading'
    progress.value = 0
    errorMessage.value = ''
    isUploading.value = true

    const formData = new FormData()
    formData.append('file', file)

    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        progress.value = Math.round((e.loaded / e.total) * 90)
      }
    })

    xhr.upload.addEventListener('load', () => {
      phase.value = 'processing'
      progress.value = 92
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        phase.value = 'done'
        progress.value = 100
        try {
          const asset = JSON.parse(xhr.responseText)
          emit('uploaded', asset)
        }
        catch { /* parse error */ }
        setTimeout(() => {
          resetState()
          resolve()
        }, 1500)
      }
      else {
        phase.value = 'error'
        try {
          const err = JSON.parse(xhr.responseText)
          errorMessage.value = err.message ?? `Upload failed (${xhr.status})`
        }
        catch {
          errorMessage.value = `Upload failed (${xhr.status})`
        }
        emit('error', errorMessage.value)
        setTimeout(() => {
          resetState()
          resolve()
        }, 3000)
      }
    })

    xhr.addEventListener('error', () => {
      phase.value = 'error'
      errorMessage.value = 'Network error'
      emit('error', errorMessage.value)
      setTimeout(() => {
        resetState()
        resolve()
      }, 3000)
    })

    xhr.open('POST', `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/media`)
    xhr.send(formData)
  })
}

function resetState() {
  isUploading.value = false
  phase.value = 'idle'
  progress.value = 0
  currentFile.value = null
  errorMessage.value = ''
}

const progressBarColor = computed(() => {
  if (phase.value === 'error') return 'bg-danger-500'
  if (phase.value === 'done') return 'bg-success-500'
  return 'bg-primary-500'
})

const statusText = computed(() => {
  if (phase.value === 'uploading') return `${t('media.uploading')} ${progress.value}%`
  if (phase.value === 'processing') return t('media.processing')
  if (phase.value === 'done') return t('media.upload_success')
  if (phase.value === 'error') return errorMessage.value
  return ''
})
</script>

<template>
  <div
    class="relative overflow-hidden rounded-lg border-2 border-dashed transition-all"
    :class="[
      isDragging ? 'border-primary-500 bg-primary-50/50 dark:bg-primary-900/10' : 'border-secondary-200 dark:border-secondary-700',
      isUploading ? 'pointer-events-none' : '',
    ]"
    @dragover.prevent="isDragging = true"
    @dragleave="isDragging = false"
    @drop.prevent="handleDrop"
  >
    <!-- Upload progress overlay -->
    <div v-if="isUploading" class="p-4">
      <div class="mb-2 flex items-center gap-2">
        <span
          v-if="phase === 'done'"
          class="icon-[annon--check-circle] size-4 text-success-500"
          aria-hidden="true"
        />
        <span
          v-else-if="phase === 'error'"
          class="icon-[annon--alert-circle] size-4 text-danger-500"
          aria-hidden="true"
        />
        <span
          v-else
          class="icon-[annon--loader] size-4 animate-spin text-primary-500"
          aria-hidden="true"
        />
        <span class="truncate text-xs font-medium text-heading dark:text-secondary-100">
          {{ currentFile }}
        </span>
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-secondary-100 dark:bg-secondary-800">
        <div
          class="h-full rounded-full transition-all duration-300 ease-out"
          :class="progressBarColor"
          :style="{ width: `${progress}%` }"
        />
      </div>
      <p class="mt-1.5 text-[11px] text-muted">
        {{ statusText }}
      </p>
    </div>

    <!-- Drop zone (idle) -->
    <div v-else class="flex flex-col items-center justify-center px-4 py-5">
      <span class="icon-[annon--cloud-upload] mb-1.5 size-7 text-secondary-300 dark:text-secondary-600" aria-hidden="true" />
      <p class="text-sm text-body dark:text-secondary-300">
        {{ t('media.drag_drop') }}
      </p>
      <p class="mt-0.5 text-xs text-muted">
        {{ t('media.or') }}
      </p>
      <AtomsBaseButton type="button" variant="ghost" size="sm" class="mt-1.5" @click="openFilePicker">
        {{ t('media.browse_files') }}
      </AtomsBaseButton>
    </div>

    <input
      ref="fileInput"
      type="file"
      class="hidden"
      accept="image/*,video/mp4,video/webm,application/pdf"
      multiple
      @change="handleFileSelect"
    >
  </div>
</template>
