<script setup lang="ts">
const { t } = useContent()

const props = defineProps<{
  workspaceId: string
  projectId: string
  editable?: boolean
}>()

const { assets, total, loading, filters, fetchAssets, deleteAsset, clearLibrary } = useMediaLibrary()
const { toggle, isPinned } = useChatContext()
const toast = useToast()
const modalOpen = ref(false)

// Bulk selection
const selectedIds = ref<Set<string>>(new Set())
const isSelecting = computed(() => selectedIds.value.size > 0)

function clearSelection() {
  selectedIds.value = new Set()
}

async function handleBulkDelete() {
  const ids = [...selectedIds.value]
  for (const id of ids) {
    await deleteAsset(props.workspaceId, props.projectId, id)
  }
  clearSelection()
  await fetchAssets(props.workspaceId, props.projectId)
}

function togglePin(asset: { id: string, filename: string, originalPath: string, format: string, width: number, height: number, size: number, alt: string | null }) {
  toggle({
    type: 'asset',
    label: asset.filename,
    sublabel: `${asset.format?.toUpperCase()} · ${asset.width}×${asset.height}`,
    modelId: asset.id,
    assetId: asset.id,
    data: { filename: asset.filename, originalPath: asset.originalPath, format: asset.format, width: asset.width, height: asset.height, size: asset.size, alt: asset.alt },
  })
}

onMounted(() => {
  fetchAssets(props.workspaceId, props.projectId)
})

let searchTimeout: ReturnType<typeof setTimeout>
watch(() => filters.value.search, () => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    filters.value.page = 1
    fetchAssets(props.workspaceId, props.projectId)
  }, 300)
})

function openAssetDetail() {
  modalOpen.value = true
}

function handleUploaded() {
  fetchAssets(props.workspaceId, props.projectId)
}

function handleUploadError(message: string) {
  toast.error(message)
}

onUnmounted(() => {
  clearLibrary()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex shrink-0 items-center gap-2 border-b border-secondary-200 px-4 py-2.5 dark:border-secondary-800">
      <AtomsFormInput
        v-model="filters.search"
        :placeholder="t('media.search_placeholder')"
        class="flex-1"
      />
      <AtomsIconButton
        icon="icon-[annon--maximize]"
        :label="t('media.open_full')"
        size="sm"
        @click="modalOpen = true"
      />
    </div>

    <!-- Bulk actions bar -->
    <div
      v-if="isSelecting"
      class="flex items-center gap-3 border-b border-warning-200 bg-warning-50 px-4 py-2 dark:border-warning-800 dark:bg-warning-900/20"
    >
      <span class="text-xs font-medium text-warning-700 dark:text-warning-400">
        {{ selectedIds.size }} {{ t('media.selected') }}
      </span>
      <AtomsBaseButton type="button" variant="danger" size="sm" @click="handleBulkDelete">
        {{ t('common.delete') }}
      </AtomsBaseButton>
      <AtomsBaseButton type="button" variant="ghost" size="sm" @click="clearSelection">
        {{ t('media.clear_selection') }}
      </AtomsBaseButton>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      <!-- Upload zone -->
      <div v-if="editable" class="p-4 pb-2">
        <MoleculesAssetUploader
          :workspace-id="workspaceId"
          :project-id="projectId"
          @uploaded="handleUploaded"
          @error="handleUploadError"
        />
      </div>

      <!-- Loading -->
      <div v-if="loading" class="grid grid-cols-2 gap-2 p-4">
        <AtomsSkeleton v-for="i in 6" :key="i" variant="custom" class="aspect-square w-full rounded-lg" />
      </div>

      <!-- Empty state -->
      <div v-else-if="assets.length === 0 && !loading" class="p-5">
        <AtomsEmptyState
          icon="icon-[annon--image-3]"
          :title="t('media.empty_title')"
          :description="t('media.empty_description')"
        />
      </div>

      <!-- Compact asset grid (2 cols for sidebar) -->
      <div v-else class="grid grid-cols-2 gap-2 p-4">
        <AtomsAssetCard
          v-for="asset in assets"
          :key="asset.id"
          :asset-id="asset.id"
          :filename="asset.filename"
          :original-path="asset.originalPath"
          :content-type="asset.contentType"
          :preview-url="`/api/workspaces/${workspaceId}/projects/${projectId}/media/${asset.id}/preview`"
          :format="asset.format"
          :size="asset.size"
          :alt="asset.alt"
          :pinned="isPinned('asset', asset.id, undefined, undefined, asset.id)"
          @click="openAssetDetail"
          @pin="togglePin(asset)"
        />
      </div>

      <!-- Footer -->
      <div v-if="total > 0" class="border-t border-secondary-100 px-4 py-2 dark:border-secondary-800">
        <span class="text-xs text-muted">{{ total }} {{ t('media.assets_count') }}</span>
      </div>
    </div>

    <!-- Full-screen modal -->
    <OrganismsAssetManagerModal
      v-model:open="modalOpen"
      :workspace-id="workspaceId"
      :project-id="projectId"
      :editable="editable"
    />
  </div>
</template>
