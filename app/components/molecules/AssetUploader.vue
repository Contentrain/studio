<script setup lang="ts">
const { t } = useContent()

const emit = defineEmits<{
  upload: [file: File]
}>()

const isDragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function handleDrop(e: DragEvent) {
  isDragging.value = false
  const file = e.dataTransfer?.files[0]
  if (file) emit('upload', file)
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) emit('upload', file)
  input.value = '' // Reset for same file re-upload
}

function openFilePicker() {
  fileInput.value?.click()
}
</script>

<template>
  <div
    class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors"
    :class="isDragging
      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/10'
      : 'border-secondary-200 bg-secondary-50/50 dark:border-secondary-700 dark:bg-secondary-900/50'"
    @dragover.prevent="isDragging = true"
    @dragleave="isDragging = false"
    @drop.prevent="handleDrop"
  >
    <span class="icon-[annon--cloud-upload] mb-2 size-8 text-secondary-300 dark:text-secondary-600" aria-hidden="true" />
    <p class="text-sm text-body dark:text-secondary-300">
      {{ t('media.drag_drop') }}
    </p>
    <p class="mt-1 text-xs text-muted">
      {{ t('media.or') }}
    </p>
    <AtomsBaseButton type="button" variant="ghost" size="sm" class="mt-2" @click="openFilePicker">
      {{ t('media.browse_files') }}
    </AtomsBaseButton>
    <input
      ref="fileInput"
      type="file"
      class="hidden"
      accept="image/*,video/mp4,video/webm,application/pdf"
      @change="handleFileSelect"
    >
  </div>
</template>
