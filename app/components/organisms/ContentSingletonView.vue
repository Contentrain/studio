<script setup lang="ts">
const props = defineProps<{
  content: Record<string, unknown>
  workspaceId?: string
  projectId?: string
  modelId?: string
  locale?: string
  editable?: boolean
}>()

const emit = defineEmits<{
  saved: []
}>()

const getFieldType = inject<(fieldId: string) => string>('getFieldType', () => 'string')
const getUserFieldIds = inject<() => string[]>('getUserFieldIds', () => [])

const { editingField, editValue, saving, startEdit, cancelEdit, saveField } = useContentEditor()

async function handleSave(fieldId: string) {
  if (!props.workspaceId || !props.projectId || !props.modelId) return
  const success = await saveField(
    props.workspaceId,
    props.projectId,
    props.modelId,
    props.locale ?? 'en',
    undefined,
    fieldId,
    editValue.value,
  )
  if (success) emit('saved')
}
</script>

<template>
  <div class="space-y-4 p-5">
    <template v-for="fieldId in getUserFieldIds()" :key="fieldId">
      <div v-if="fieldId in content">
        <AtomsSectionLabel :label="fieldId" class="px-0 py-0" />
        <div class="mt-1">
          <!-- Edit mode -->
          <AtomsContentFieldEditor
            v-if="editable && editingField === fieldId"
            v-model="editValue"
            :type="getFieldType(fieldId)"
            :field-id="fieldId"
            :saving="saving"
            @save="handleSave(fieldId)"
            @cancel="cancelEdit"
          />
          <!-- Display mode (click to edit) -->
          <div
            v-else
            :class="editable ? 'cursor-pointer rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-secondary-50 dark:hover:bg-secondary-900' : ''"
            @click="editable ? startEdit(fieldId, content[fieldId]) : undefined"
          >
            <AtomsContentFieldDisplay :type="getFieldType(fieldId)" :value="content[fieldId]" :field-id="fieldId" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
