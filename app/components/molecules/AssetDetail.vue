<script setup lang="ts">
const { t } = useContent()

const props = defineProps<{
  asset: {
    id: string
    filename: string
    contentType: string
    size: number
    width: number
    height: number
    format: string
    blurhash: string | null
    alt: string | null
    tags: readonly string[]
    originalPath: string
    previewUrl?: string
    variants: Readonly<Record<string, { path: string, width: number, height: number, format: string, size: number }>>
    source: string
    createdAt: string
  }
  editable?: boolean
}>()

const emit = defineEmits<{
  save: [metadata: { alt?: string, tags?: string[] }]
  delete: []
  close: []
}>()

const editAlt = ref(props.asset.alt ?? '')
const editTags = ref(props.asset.tags.join(', '))

watch(() => props.asset, (a) => {
  editAlt.value = a.alt ?? ''
  editTags.value = a.tags.join(', ')
})

const isImage = computed(() => props.asset.contentType.startsWith('image/'))
const isVideo = computed(() => props.asset.contentType.startsWith('video/'))

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function handleSave() {
  emit('save', {
    alt: editAlt.value.trim() || undefined,
    tags: editTags.value.split(',').map(t => t.trim()).filter(Boolean),
  })
}

const copied = ref(false)
function copyPath() {
  navigator.clipboard.writeText(props.asset.originalPath)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-secondary-200 px-4 py-3 dark:border-secondary-800">
      <AtomsHeadingText :level="4" size="xs" truncate class="flex-1">
        {{ asset.filename }}
      </AtomsHeadingText>
      <AtomsIconButton icon="icon-[annon--cross]" :label="t('common.close')" size="sm" @click="emit('close')" />
    </div>

    <!-- Body -->
    <div class="flex-1 space-y-4 overflow-y-auto p-4">
      <!-- Preview -->
      <div class="flex items-center justify-center overflow-hidden rounded-lg bg-secondary-100 dark:bg-secondary-800/50" :class="isImage && asset.previewUrl ? 'p-0' : 'p-6'">
        <img
          v-if="isImage && asset.previewUrl"
          :src="asset.previewUrl"
          :alt="asset.alt ?? asset.filename"
          class="max-h-48 max-w-full object-contain"
        >
        <div v-else class="text-center">
          <span
            :class="[isImage ? 'icon-[annon--image-3]' : isVideo ? 'icon-[annon--video-library]' : 'icon-[annon--file-text]',
                     'size-12 text-secondary-400 dark:text-secondary-500']"
            aria-hidden="true"
          />
          <div v-if="asset.width && asset.height" class="mt-1 text-[10px] text-muted">
            {{ asset.width }}×{{ asset.height }}
          </div>
        </div>
      </div>

      <!-- Metadata -->
      <div class="space-y-3">
        <div>
          <AtomsSectionLabel :label="t('media.dimensions')" class="px-0 py-0" />
          <span class="text-sm tabular-nums text-heading dark:text-secondary-100">{{ asset.width }}×{{ asset.height }} · {{ asset.format.toUpperCase() }}</span>
        </div>
        <div>
          <AtomsSectionLabel :label="t('media.file_size')" class="px-0 py-0" />
          <span class="text-sm text-heading dark:text-secondary-100">{{ formatSize(asset.size) }}</span>
        </div>
        <div>
          <AtomsSectionLabel :label="t('media.uploaded')" class="px-0 py-0" />
          <span class="text-sm text-heading dark:text-secondary-100">{{ formatDate(asset.createdAt) }}</span>
        </div>
        <div>
          <AtomsSectionLabel :label="t('media.path')" class="px-0 py-0" />
          <div class="flex items-center gap-1.5">
            <code class="flex-1 truncate rounded bg-secondary-100 px-2 py-1 text-xs text-heading dark:bg-secondary-800 dark:text-secondary-100">{{ asset.originalPath }}</code>
            <AtomsIconButton
              :icon="copied ? 'icon-[annon--check]' : 'icon-[annon--copy]'"
              :label="t('common.copy')" size="sm" @click="copyPath"
            />
          </div>
        </div>

        <!-- Variants -->
        <div v-if="Object.keys(asset.variants).length > 0">
          <AtomsSectionLabel :label="t('media.variants')" class="px-0 py-0" />
          <div class="space-y-1">
            <div
              v-for="(v, name) in asset.variants" :key="name"
              class="flex items-center justify-between rounded bg-secondary-50 px-2.5 py-1.5 text-xs dark:bg-secondary-900"
            >
              <span class="font-medium text-label">{{ name }}</span>
              <span class="tabular-nums text-muted">{{ v.width }}×{{ v.height }} · {{ formatSize(v.size) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Editable fields -->
      <template v-if="editable">
        <div>
          <AtomsFormLabel :label="t('media.alt_text')" />
          <AtomsFormInput v-model="editAlt" :placeholder="t('media.alt_placeholder')" />
        </div>
        <div>
          <AtomsFormLabel :label="t('media.tags')" />
          <AtomsFormInput v-model="editTags" :placeholder="t('media.tags_placeholder')" />
        </div>
        <div class="flex gap-2">
          <AtomsBaseButton type="button" variant="primary" size="sm" @click="handleSave">
            {{ t('common.save') }}
          </AtomsBaseButton>
          <AtomsBaseButton type="button" variant="danger" size="sm" @click="emit('delete')">
            {{ t('common.delete') }}
          </AtomsBaseButton>
        </div>
      </template>
    </div>
  </div>
</template>
