<script setup lang="ts">
const { t } = useContent()

const props = defineProps<{
  modelValue: string | null
  accept?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
}>()

const isImage = computed(() => {
  const path = props.modelValue ?? ''
  return /\.(jpg|jpeg|png|gif|webp|avif|svg)$/i.test(path)
})

function clearValue() {
  emit('update:modelValue', null)
}
</script>

<template>
  <div class="space-y-2">
    <!-- Preview -->
    <div v-if="modelValue" class="group relative">
      <div class="flex items-center gap-3 rounded-lg border border-secondary-200 p-2 dark:border-secondary-700">
        <div class="flex size-12 shrink-0 items-center justify-center rounded bg-secondary-50 dark:bg-secondary-900">
          <NuxtImg
            v-if="isImage"
            :src="modelValue"
            :alt="modelValue"
            class="size-full rounded object-cover"
          />
          <span v-else class="icon-[annon--file] size-5 text-secondary-300" aria-hidden="true" />
        </div>
        <div class="min-w-0 flex-1">
          <code class="block truncate text-xs text-heading dark:text-secondary-100">{{ modelValue }}</code>
        </div>
        <AtomsIconButton
          icon="icon-[annon--cross]"
          :label="t('common.clear')"
          size="sm"
          @click="clearValue"
        />
      </div>
    </div>

    <!-- Input (manual path or URL) -->
    <AtomsFormInput
      :model-value="String(modelValue ?? '')"
      type="url"
      :placeholder="t('media.path_placeholder')"
      :description="t('media.path_description')"
      @update:model-value="emit('update:modelValue', $event || null)"
    />
  </div>
</template>
