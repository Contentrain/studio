<script setup lang="ts">
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'

const { t } = useContent()

const props = defineProps<{
  open: boolean
  workspaceId: string
  projectId: string
  editable?: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const { assets, total, loading, selectedAsset, filters, fetchAssets, updateAsset, deleteAsset, bulkDelete, selectAsset } = useMediaLibrary()
const { toggle: toggleContext, isPinned } = useChatContext()
const toast = useToast()

function togglePin(asset: { id: string, filename: string, originalPath: string, format: string, width: number, height: number, size: number, alt: string | null }) {
  toggleContext({
    type: 'asset',
    label: asset.filename,
    sublabel: `${asset.format?.toUpperCase()} · ${asset.width}×${asset.height}`,
    modelId: asset.id,
    assetId: asset.id,
    data: { filename: asset.filename, originalPath: asset.originalPath, format: asset.format, width: asset.width, height: asset.height, size: asset.size, alt: asset.alt },
  })
}

const selectedIds = ref<Set<string>>(new Set())
const isSelecting = computed(() => selectedIds.value.size > 0)

function toggleSelect(assetId: string) {
  const next = new Set(selectedIds.value)
  if (next.has(assetId)) next.delete(assetId)
  else next.add(assetId)
  selectedIds.value = next
}

watch(() => props.open, (open) => {
  if (open) {
    fetchAssets(props.workspaceId, props.projectId)
  }
  else {
    selectedIds.value = new Set()
    selectAsset(null)
  }
})

let searchTimeout: ReturnType<typeof setTimeout>
watch(() => filters.value.search, () => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    filters.value.page = 1
    fetchAssets(props.workspaceId, props.projectId)
  }, 300)
})

watch(() => [filters.value.type, filters.value.sort], () => {
  filters.value.page = 1
  fetchAssets(props.workspaceId, props.projectId)
})

function handleUploaded() {
  fetchAssets(props.workspaceId, props.projectId)
}

function handleUploadError(message: string) {
  toast.error(message)
}

async function handleSave(metadata: { alt?: string, tags?: string[] }) {
  if (!selectedAsset.value) return
  try {
    await updateAsset(props.workspaceId, props.projectId, selectedAsset.value.id, metadata)
    toast.success(t('media.save_success'))
  }
  catch {
    toast.error(t('media.save_error'))
  }
}

async function handleDelete() {
  if (!selectedAsset.value) return
  try {
    await deleteAsset(props.workspaceId, props.projectId, selectedAsset.value.id)
    toast.success(t('media.delete_success'))
  }
  catch {
    toast.error(t('media.delete_error'))
  }
}

async function handleBulkDelete() {
  const ids = Array.from(selectedIds.value)
  if (!ids.length) return
  try {
    await bulkDelete(props.workspaceId, props.projectId, ids)
    selectedIds.value = new Set()
    toast.success(t('media.bulk_delete_success'))
  }
  catch {
    toast.error(t('media.delete_error'))
  }
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <DialogContent
        class="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl border border-secondary-200 bg-white shadow-2xl dark:border-secondary-800 dark:bg-secondary-950"
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center gap-3 border-b border-secondary-200 px-6 py-4 dark:border-secondary-800">
          <DialogTitle class="flex-1 text-lg font-semibold text-heading dark:text-secondary-100">
            {{ t('media.title') }}
          </DialogTitle>
          <AtomsBadge v-if="total > 0" variant="secondary" size="sm">
            {{ total }} {{ t('media.assets_count') }}
          </AtomsBadge>
          <DialogClose
            class="rounded-md p-1 text-muted transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
          >
            <span class="icon-[annon--cross] size-5" aria-hidden="true" />
          </DialogClose>
        </div>

        <!-- Toolbar -->
        <div class="flex shrink-0 items-center gap-3 border-b border-secondary-100 px-6 py-3 dark:border-secondary-800/50">
          <AtomsFormInput
            v-model="filters.search"
            :placeholder="t('media.search_placeholder')"
            class="max-w-xs flex-1"
          />
          <AtomsFormSelect
            :model-value="filters.type"
            :options="[
              { value: 'all', label: t('media.all_types') },
              { value: 'image', label: t('media.images') },
              { value: 'video', label: t('media.videos') },
              { value: 'application', label: t('media.files') },
            ]"
            size="sm"
            @update:model-value="filters.type = $event"
          />
          <AtomsFormSelect
            :model-value="filters.sort"
            :options="[
              { value: 'newest', label: t('media.sort_newest') },
              { value: 'oldest', label: t('media.sort_oldest') },
              { value: 'name', label: t('media.sort_name') },
              { value: 'size', label: t('media.sort_size') },
            ]"
            size="sm"
            @update:model-value="filters.sort = $event as 'newest' | 'oldest' | 'name' | 'size'"
          />
          <div class="ml-auto" />
          <!-- Bulk actions -->
          <template v-if="isSelecting">
            <span class="text-xs font-medium text-warning-600 dark:text-warning-400">
              {{ selectedIds.size }} {{ t('media.selected') }}
            </span>
            <AtomsBaseButton type="button" variant="danger" size="sm" @click="handleBulkDelete">
              {{ t('common.delete') }}
            </AtomsBaseButton>
            <AtomsBaseButton type="button" variant="ghost" size="sm" @click="selectedIds = new Set()">
              {{ t('media.clear_selection') }}
            </AtomsBaseButton>
          </template>
        </div>

        <!-- Body -->
        <div class="flex flex-1 overflow-hidden">
          <!-- Grid area -->
          <div class="flex-1 overflow-y-auto">
            <!-- Upload zone -->
            <div v-if="editable" class="px-6 pt-4 pb-2">
              <MoleculesAssetUploader
                :workspace-id="workspaceId"
                :project-id="projectId"
                @uploaded="handleUploaded"
                @error="handleUploadError"
              />
            </div>

            <!-- Loading -->
            <div v-if="loading" class="grid grid-cols-2 gap-3 p-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              <AtomsSkeleton v-for="i in 12" :key="i" variant="custom" class="aspect-square w-full rounded-lg" />
            </div>

            <!-- Empty state -->
            <div v-else-if="assets.length === 0" class="flex flex-1 items-center justify-center p-12">
              <AtomsEmptyState
                icon="icon-[annon--image-3]"
                :title="t('media.empty_title')"
                :description="t('media.empty_description')"
              />
            </div>

            <!-- Asset grid -->
            <div v-else class="grid grid-cols-2 gap-3 p-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
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
                :selected="selectedAsset?.id === asset.id || selectedIds.has(asset.id)"
                :pinned="isPinned('asset', asset.id, undefined, undefined, asset.id)"
                @click="isSelecting ? toggleSelect(asset.id) : selectAsset(asset)"
                @pin="togglePin(asset)"
              />
            </div>
          </div>

          <!-- Detail sidebar -->
          <div
            v-if="selectedAsset"
            class="w-80 shrink-0 border-l border-secondary-200 dark:border-secondary-800"
          >
            <MoleculesAssetDetail
              :asset="{ ...selectedAsset, previewUrl: `/api/workspaces/${workspaceId}/projects/${projectId}/media/${selectedAsset.id}/preview` }"
              :editable="editable"
              @save="handleSave"
              @delete="handleDelete"
              @close="selectAsset(null)"
            />
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
