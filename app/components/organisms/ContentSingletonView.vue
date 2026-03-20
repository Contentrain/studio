<script setup lang="ts">
defineProps<{
  content: Record<string, unknown>
}>()

const getFieldType = inject<(fieldId: string) => string>('getFieldType', () => 'string')
const getUserFieldIds = inject<() => string[]>('getUserFieldIds', () => [])
</script>

<template>
  <div class="space-y-4 p-5">
    <template v-for="fieldId in getUserFieldIds()" :key="fieldId">
      <div v-if="fieldId in content">
        <AtomsSectionLabel :label="fieldId" class="px-0 py-0" />
        <div class="mt-1">
          <AtomsContentFieldDisplay :type="getFieldType(fieldId)" :value="content[fieldId]" :field-id="fieldId" />
        </div>
      </div>
    </template>
  </div>
</template>
