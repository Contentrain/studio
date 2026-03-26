<script setup lang="ts">
const { t } = useContent()

const props = defineProps<{
  workspaceId: string
  projectId: string
  editable?: boolean
}>()

const { activeWorkspace } = useWorkspaces()
const isPro = computed(() => hasFeature(activeWorkspace.value?.plan, 'media.library'))

const { assets, total, loading, uploading, filters, fetchAssets, uploadFile, clearLibrary } = useMediaLibrary()
const toast = useToast()
const modalOpen = ref(false)

// Fetch on mount (skip on free plan)
onMounted(() => {
  if (isPro.value) fetchAssets(props.workspaceId, props.projectId)
})

// Search debounce
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

async function handleUpload(file: File) {
  try {
    await uploadFile(props.workspaceId, props.projectId, file)
    toast.success(t('media.upload_success'))
  }
  catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : t('media.upload_error'))
  }
}

onUnmounted(() => {
  clearLibrary()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Upgrade nudge for free plan -->
    <div v-if="!isPro" class="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div class="mb-4 flex size-14 items-center justify-center rounded-2xl bg-secondary-100 dark:bg-secondary-800">
        <span class="icon-[annon--image-3] size-7 text-secondary-400" aria-hidden="true" />
      </div>
      <AtomsHeadingText :level="3" size="sm" class="mb-2">
        {{ t('media.title') }}
      </AtomsHeadingText>
      <p class="mb-4 max-w-xs text-sm text-muted">
        {{ t('media.pro_required') }}
      </p>
      <AtomsBadge variant="info" size="sm">
        Pro
      </AtomsBadge>
    </div>

    <!-- Full asset manager (Pro+) -->
    <template v-else>
      <!-- Header -->
      <div class="flex shrink-0 items-center gap-2 border-b border-secondary-200 px-4 py-2.5 dark:border-secondary-800">
        <AtomsFormInput
          v-model="filters.search"
          :placeholder="t('media.search_placeholder')"
          class="flex-1"
        />
        <button
          type="button"
          :aria-label="t('media.open_full')"
          class="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-secondary-100 hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-800 dark:hover:text-secondary-100"
          @click="modalOpen = true"
        >
          <svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9.5 1.5h5v5M6.5 14.5h-5v-5M14.5 1.5L9 7M1.5 14.5L7 9" />
          </svg>
        </button>
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
          <MoleculesAssetUploader @upload="handleUpload" />
          <div v-if="uploading" class="mt-2 flex items-center gap-2 text-xs text-muted">
            <span class="icon-[annon--loader] size-3.5 animate-spin" aria-hidden="true" />
            {{ t('media.uploading') }}
          </div>
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
            :filename="asset.filename"
            :original-path="asset.originalPath"
            :content-type="asset.contentType"
            :preview-url="`/api/workspaces/${workspaceId}/projects/${projectId}/media/${asset.id}/preview`"
            :format="asset.format"
            :size="asset.size"
            :alt="asset.alt"
            @click="openAssetDetail"
          />
        </div>

        <!-- Footer -->
        <div v-if="total > 0" class="border-t border-secondary-100 px-4 py-2 dark:border-secondary-800">
          <span class="text-xs text-muted">{{ total }} {{ t('media.assets_count') }}</span>
        </div>
      </div>
    </template>

    <!-- Full-screen modal -->
    <OrganismsAssetManagerModal
      v-model:open="modalOpen"
      :workspace-id="workspaceId"
      :project-id="projectId"
      :editable="editable"
    />
  </div>
</template>
