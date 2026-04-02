/**
 * Content editor composable.
 * Supports two modes:
 * - Inline: single field editing (existing behavior)
 * - Batch: edit all fields at once, save in one commit (for modal editor)
 */

export function useContentEditor() {
  // --- Inline editing state (single field) ---
  const editingField = ref<string | null>(null)
  const editValue = ref<unknown>(null)
  const originalValue = ref<unknown>(null)
  const saving = ref(false)
  const saveError = ref<string | null>(null)
  const toast = useToast()

  // --- Batch editing state (all fields) ---
  const batchEditData = ref<Record<string, unknown> | null>(null)
  const batchOriginalData = ref<Record<string, unknown> | null>(null)
  const batchDirtyFields = ref<Set<string>>(new Set())

  // ═══ Inline editing ═══

  function startEdit(fieldId: string, currentValue: unknown) {
    editingField.value = fieldId
    editValue.value = typeof currentValue === 'object' ? JSON.parse(JSON.stringify(currentValue)) : currentValue
    originalValue.value = currentValue
    saveError.value = null
  }

  function cancelEdit() {
    editingField.value = null
    editValue.value = null
    originalValue.value = null
    saveError.value = null
  }

  async function saveField(
    workspaceId: string,
    projectId: string,
    modelId: string,
    locale: string,
    entryId: string | undefined,
    fieldId: string,
    value: unknown,
  ): Promise<boolean> {
    saving.value = true
    saveError.value = null

    try {
      let data: Record<string, unknown>

      if (entryId) {
        data = { [entryId]: { [fieldId]: value } }
      }
      else {
        data = { [fieldId]: value }
      }

      const result = await $fetch<{
        branch: string
        validation: { valid: boolean, errors: Array<{ message: string }> }
      }>(`/api/workspaces/${workspaceId}/projects/${projectId}/content/${modelId}`, {
        method: 'POST',
        body: { locale, data },
      })

      if (!result.validation.valid) {
        saveError.value = result.validation.errors.map(e => e.message).join(', ')
        return false
      }

      toast.success(`Saved to branch: ${result.branch}`)
      editingField.value = null
      editValue.value = null
      return true
    }
    catch (e: unknown) {
      const { t } = useContent()
      saveError.value = resolveApiError(e, t('content.save_error'))
      toast.error(saveError.value)
      return false
    }
    finally {
      saving.value = false
    }
  }

  const isEditing = computed(() => editingField.value !== null)
  const hasChanges = computed(() => {
    if (!editingField.value) return false
    return JSON.stringify(editValue.value) !== JSON.stringify(originalValue.value)
  })

  // ═══ Batch editing ═══

  function startBatchEdit(entryData: Record<string, unknown>) {
    batchEditData.value = JSON.parse(JSON.stringify(entryData))
    batchOriginalData.value = JSON.parse(JSON.stringify(entryData))
    batchDirtyFields.value = new Set()
    saveError.value = null
  }

  function normalizeForCompare(val: unknown): unknown {
    if (val === undefined || val === null || val === '') return null
    return val
  }

  function updateBatchField(fieldId: string, value: unknown) {
    if (!batchEditData.value) return
    batchEditData.value[fieldId] = value

    const normalized = normalizeForCompare(value)
    const original = normalizeForCompare(batchOriginalData.value?.[fieldId])
    if (JSON.stringify(normalized) !== JSON.stringify(original)) {
      batchDirtyFields.value.add(fieldId)
    }
    else {
      batchDirtyFields.value.delete(fieldId)
    }
  }

  function cancelBatchEdit() {
    batchEditData.value = null
    batchOriginalData.value = null
    batchDirtyFields.value = new Set()
    saveError.value = null
  }

  async function saveBatch(
    workspaceId: string,
    projectId: string,
    modelId: string,
    locale: string,
    entryId?: string,
  ): Promise<boolean> {
    if (!batchEditData.value || batchDirtyFields.value.size === 0) return true

    // Send only dirty fields — server validates after merge with existing
    const dirtyData: Record<string, unknown> = {}
    for (const fieldId of batchDirtyFields.value) {
      dirtyData[fieldId] = batchEditData.value[fieldId]
    }

    saving.value = true
    saveError.value = null

    try {
      let data: Record<string, unknown>

      if (entryId) {
        data = { [entryId]: dirtyData }
      }
      else {
        data = dirtyData
      }

      const result = await $fetch<{
        branch: string
        validation: { valid: boolean, errors: Array<{ message: string }> }
      }>(`/api/workspaces/${workspaceId}/projects/${projectId}/content/${modelId}`, {
        method: 'POST',
        body: { locale, data },
      })

      if (!result.validation.valid) {
        saveError.value = result.validation.errors.map(e => e.message).join(', ')
        return false
      }

      toast.success(`Saved to branch: ${result.branch}`)
      cancelBatchEdit()
      return true
    }
    catch (e: unknown) {
      const { t } = useContent()
      saveError.value = resolveApiError(e, t('content.save_error'))
      toast.error(saveError.value)
      return false
    }
    finally {
      saving.value = false
    }
  }

  const isBatchEditing = computed(() => batchEditData.value !== null)
  const hasBatchChanges = computed(() => batchDirtyFields.value.size > 0)
  const dirtyFieldCount = computed(() => batchDirtyFields.value.size)

  return {
    // Inline
    editingField: readonly(editingField),
    editValue,
    saving: readonly(saving),
    saveError: readonly(saveError),
    isEditing,
    hasChanges,
    startEdit,
    cancelEdit,
    saveField,
    // Batch
    batchEditData: readonly(batchEditData),
    isBatchEditing,
    hasBatchChanges,
    dirtyFieldCount,
    startBatchEdit,
    updateBatchField,
    cancelBatchEdit,
    saveBatch,
  }
}
