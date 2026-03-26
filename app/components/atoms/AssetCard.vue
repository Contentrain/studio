<script setup lang="ts">
const props = defineProps<{
  assetId: string
  filename: string
  originalPath: string
  contentType: string
  previewUrl?: string
  width?: number
  height?: number
  format?: string
  size?: number
  alt?: string | null
  blurhash?: string | null
  selected?: boolean
  pinned?: boolean
}>()

defineEmits<{
  click: []
  pin: []
}>()

const { startDrag, endDrag } = useChatContext()

const isImage = computed(() => props.contentType.startsWith('image/'))
const isVideo = computed(() => props.contentType.startsWith('video/'))

const typeIcon = computed(() => {
  if (isVideo.value) return 'icon-[annon--video-library]'
  if (isImage.value) return 'icon-[annon--image-3]'
  if (props.contentType === 'application/pdf') return 'icon-[annon--file-text]'
  return 'icon-[annon--file]'
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <div
    class="group relative flex flex-col overflow-hidden rounded-lg border transition-colors"
    :class="selected
      ? 'border-primary-500 ring-2 ring-primary-500/30'
      : 'border-secondary-200 hover:border-secondary-300 dark:border-secondary-700 dark:hover:border-secondary-600'"
    draggable="true"
    @dragstart="startDrag($event, { type: 'asset', label: filename, sublabel: `${format?.toUpperCase()} · ${formatSize(size ?? 0)}`, modelId: assetId, assetId, data: { filename, originalPath, format, width, height, size, alt } })"
    @dragend="endDrag"
    @click="$emit('click')"
  >
    <!-- Preview area -->
    <div class="relative flex aspect-square w-full items-center justify-center bg-secondary-100 dark:bg-secondary-800/50">
      <img
        v-if="isImage && previewUrl"
        :src="previewUrl"
        :alt="alt ?? filename"
        class="size-full object-cover"
        loading="lazy"
      >
      <span v-else :class="[typeIcon, 'size-8 text-secondary-400 dark:text-secondary-500']" aria-hidden="true" />
    </div>

    <!-- Info -->
    <div class="min-w-0 px-2.5 py-2">
      <div class="truncate text-xs font-medium text-heading dark:text-secondary-100">
        {{ filename }}
      </div>
      <div class="flex items-center gap-1.5 text-[10px] text-muted">
        <span v-if="format" class="uppercase">{{ format }}</span>
        <span v-if="size">{{ formatSize(size) }}</span>
      </div>
    </div>

    <!-- Pin button -->
    <button
      type="button"
      aria-label="Pin to context"
      class="absolute left-1.5 top-1.5 rounded-md p-0.5 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
      :class="pinned
        ? 'text-warning-500 opacity-100'
        : 'text-white/70 opacity-0 hover:opacity-100 group-hover:opacity-60'"
      @click.stop="$emit('pin')"
    >
      <span class="icon-[annon--pin] size-3.5" aria-hidden="true" />
    </button>

    <!-- Selection indicator -->
    <div
      v-if="selected"
      class="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary-500 text-white"
    >
      <span class="icon-[annon--check] size-3" aria-hidden="true" />
    </div>
  </div>
</template>
