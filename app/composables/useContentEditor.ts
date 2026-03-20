/**
 * Content inline editor composable.
 * Manages edit state for context panel field editing.
 * Save triggers Content Engine → branch → commit.
 */

export function useContentEditor() {
  const editingField = ref<string | null>(null)
  const editValue = ref<unknown>(null)
  const originalValue = ref<unknown>(null)
  const saving = ref(false)
  const saveError = ref<string | null>(null)
  const toast = useToast()

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
      // Build the data payload
      let data: Record<string, unknown>

      if (entryId) {
        // Collection: wrap in entry object-map
        data = { [entryId]: { [fieldId]: value } }
      }
      else {
        // Singleton: flat
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
      saveError.value = e instanceof Error ? e.message : 'Save failed'
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

  return {
    editingField: readonly(editingField),
    editValue,
    saving: readonly(saving),
    saveError: readonly(saveError),
    isEditing,
    hasChanges,
    startEdit,
    cancelEdit,
    saveField,
  }
}
