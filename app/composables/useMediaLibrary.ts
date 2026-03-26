import type { DeepReadonly } from 'vue'

export interface MediaAssetUI {
  id: string
  filename: string
  contentType: string
  size: number
  width: number
  height: number
  format: string
  blurhash: string | null
  alt: string | null
  tags: string[]
  originalPath: string
  previewUrl?: string
  variants: Record<string, { path: string, width: number, height: number, format: string, size: number }>
  source: string
  createdAt: string
  updatedAt: string
}

export function useMediaLibrary() {
  const assets = useState<MediaAssetUI[]>('media-assets', () => [])
  const total = useState<number>('media-total', () => 0)
  const loading = useState('media-loading', () => false)
  const uploading = useState('media-uploading', () => false)
  const selectedAsset = useState<MediaAssetUI | null>('media-selected', () => null)

  const filters = useState('media-filters', () => ({
    search: '',
    tags: [] as string[],
    type: 'all',
    page: 1,
    limit: 50,
    sort: 'newest' as 'newest' | 'oldest' | 'name' | 'size',
  }))

  async function fetchAssets(workspaceId: string, projectId: string) {
    loading.value = true
    try {
      const params = new URLSearchParams()
      if (filters.value.search) params.set('search', filters.value.search)
      if (filters.value.tags.length) params.set('tags', filters.value.tags.join(','))
      if (filters.value.type && filters.value.type !== 'all') params.set('type', filters.value.type)
      params.set('page', String(filters.value.page))
      params.set('limit', String(filters.value.limit))
      params.set('sort', filters.value.sort)

      const result = await $fetch<{ assets: MediaAssetUI[], total: number }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/media?${params}`,
      )
      assets.value = result.assets
      total.value = result.total
    }
    catch {
      assets.value = []
      total.value = 0
    }
    finally {
      loading.value = false
    }
  }

  async function uploadFile(workspaceId: string, projectId: string, file: File, options?: { alt?: string, tags?: string[], variants?: string }) {
    uploading.value = true
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (options?.alt) formData.append('alt', options.alt)
      if (options?.tags?.length) formData.append('tags', options.tags.join(','))
      if (options?.variants) formData.append('variants', JSON.stringify(options.variants))

      const asset = await $fetch<MediaAssetUI>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/media`,
        { method: 'POST', body: formData },
      )
      assets.value.unshift(asset)
      total.value++
      return asset
    }
    finally {
      uploading.value = false
    }
  }

  async function uploadFromUrl(workspaceId: string, projectId: string, url: string, options?: { alt?: string, tags?: string[] }) {
    uploading.value = true
    try {
      const asset = await $fetch<MediaAssetUI>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/media/upload-url`,
        { method: 'POST', body: { url, alt: options?.alt, tags: options?.tags } },
      )
      assets.value.unshift(asset)
      total.value++
      return asset
    }
    finally {
      uploading.value = false
    }
  }

  async function updateAsset(workspaceId: string, projectId: string, assetId: string, metadata: { alt?: string, tags?: string[], focalPoint?: { x: number, y: number } }) {
    const updated = await $fetch<MediaAssetUI>(
      `/api/workspaces/${workspaceId}/projects/${projectId}/media/${assetId}`,
      { method: 'PATCH', body: metadata },
    )
    const idx = assets.value.findIndex(a => a.id === assetId)
    if (idx >= 0) assets.value[idx] = updated
    if (selectedAsset.value?.id === assetId) selectedAsset.value = updated
    return updated
  }

  async function deleteAsset(workspaceId: string, projectId: string, assetId: string) {
    await $fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/media/${assetId}`,
      { method: 'DELETE' },
    )
    assets.value = assets.value.filter(a => a.id !== assetId)
    total.value--
    if (selectedAsset.value?.id === assetId) selectedAsset.value = null
  }

  async function bulkDelete(workspaceId: string, projectId: string, assetIds: string[]) {
    await $fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/media/bulk`,
      { method: 'POST', body: { action: 'delete', assetIds } },
    )
    assets.value = assets.value.filter(a => !assetIds.includes(a.id))
    total.value -= assetIds.length
    if (selectedAsset.value && assetIds.includes(selectedAsset.value.id)) selectedAsset.value = null
  }

  function selectAsset(asset: MediaAssetUI | DeepReadonly<MediaAssetUI> | null) {
    if (!asset) {
      selectedAsset.value = null
      return
    }
    selectedAsset.value = {
      ...asset,
      tags: [...asset.tags],
      variants: { ...asset.variants },
    } as MediaAssetUI
  }

  function clearLibrary() {
    assets.value = []
    total.value = 0
    selectedAsset.value = null
    filters.value = { search: '', tags: [], type: '', page: 1, limit: 50, sort: 'newest' }
  }

  return {
    assets: readonly(assets),
    total: readonly(total),
    loading: readonly(loading),
    uploading: readonly(uploading),
    selectedAsset: readonly(selectedAsset),
    filters,
    fetchAssets,
    uploadFile,
    uploadFromUrl,
    updateAsset,
    deleteAsset,
    bulkDelete,
    selectAsset,
    clearLibrary,
  }
}
