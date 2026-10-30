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
  const { fetchBranches } = useBranches()

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

  interface SaveResponse {
    branch: string
    validation: { valid: boolean, errors: Array<{ message: string }> }
    /** Locale-agnostic fields the server also wrote to the model's other locales. */
    sharedAcrossLocales?: { fields: string[], locales: string[] }
    /** False when the project's approval policy held the write on its branch. */
    merged?: boolean
    /** Why it was held — present only when it was. */
    approval?: { risk: string, reasons: string[] }
    /** Dictionary only: a new value that already exists under another key, or is a vocabulary term. */
    advisories?: string[]
  }

  // A media or relation value lands in every locale of an i18n model; the
  // toast says which, so the editor is never left wondering whether the
  // other locale's site changed.
  function announceSave(result: SaveResponse) {
    const { t } = useContent()
    // "Saved" and "live" are not the same event on a review project, and a
    // toast that names only the branch leaves the editor to guess which one
    // just happened.
    if (result.merged === false) {
      toast.success(t('content.saved_pending_review', { branch: result.branch }))
    }
    else {
      toast.success(t('content.saved_to_branch', { branch: result.branch }))
    }
    if (result.sharedAcrossLocales && result.sharedAcrossLocales.locales.length > 0) {
      toast.success(t('content.saved_shared_locales', {
        locales: result.sharedAcrossLocales.locales.join(', '),
        fields: result.sharedAcrossLocales.fields.join(', '),
      }))
    }
    // MCP's own words: they name the key to reuse, which a paraphrase would lose.
    if (result.advisories && result.advisories.length > 0) {
      toast.info(t('content.saved_advisories'), result.advisories.join('\n'))
    }
  }

  // A write the review workflow held opened a `cr/*` branch. The sidebar's
  // Pending changes reads the shared branch list, which nothing else
  // refetches after a form save, so it stayed empty until a reload.
  function refreshPendingBranches(result: SaveResponse, workspaceId: string, projectId: string) {
    if (result.merged === false) void fetchBranches(workspaceId, projectId)
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

      const result = await $fetch<SaveResponse>(`/api/workspaces/${workspaceId}/projects/${projectId}/content/${modelId}`, {
        method: 'POST',
        body: { locale, data },
      })

      if (!result.validation.valid) {
        saveError.value = result.validation.errors.map(e => e.message).join(', ')
        return false
      }

      announceSave(result)
      refreshPendingBranches(result, workspaceId, projectId)
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

      const result = await $fetch<SaveResponse>(`/api/workspaces/${workspaceId}/projects/${projectId}/content/${modelId}`, {
        method: 'POST',
        body: { locale, data },
      })

      if (!result.validation.valid) {
        saveError.value = result.validation.errors.map(e => e.message).join(', ')
        return false
      }

      announceSave(result)
      refreshPendingBranches(result, workspaceId, projectId)
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

  // ═══ Dictionary keys ═══

  /**
   * Remove keys from, or rename a key of, a dictionary — one commit through
   * the same approval gate as a delete. A refusal (the new key exists, a key
   * is nowhere) comes back as a toast; nothing was written.
   */
  async function changeDictionaryKeys(
    workspaceId: string,
    projectId: string,
    modelId: string,
    change: { remove: string[] } | { rename: { from: string, to: string } },
  ): Promise<boolean> {
    saving.value = true
    try {
      const result = await $fetch<SaveResponse>(`/api/workspaces/${workspaceId}/projects/${projectId}/content/${modelId}/keys`, {
        method: 'PATCH',
        body: change,
      })
      if (!result.validation.valid) {
        toast.error(result.validation.errors.map(e => e.message).join(', '))
        return false
      }
      announceSave(result)
      refreshPendingBranches(result, workspaceId, projectId)
      return true
    }
    catch (e: unknown) {
      const { t } = useContent()
      toast.error(resolveApiError(e, t('content.save_error')))
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
    changeDictionaryKeys,
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
