<script setup lang="ts">
defineProps<{
  models: readonly { id: string, name: string, kind: string, type: string, fields: Readonly<Record<string, unknown>>, domain: string, i18n: boolean }[]
  content: Readonly<Record<string, { count: number, locales: string[] }>>
}>()

const emit = defineEmits<{
  select: [modelId: string]
}>()
</script>

<template>
  <div class="py-2">
    <button
      v-for="model in models"
      :key="model.id"
      type="button"
      class="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
      @click="emit('select', model.id)"
    >
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary-100 dark:bg-secondary-800">
        <span :class="getModelKindIcon(model.kind ?? model.type)" class="size-4 text-muted" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-heading dark:text-secondary-100">
          {{ model.name }}
        </div>
        <div class="flex items-center gap-2 text-xs text-muted">
          <span>{{ model.kind ?? model.type }}</span>
          <span v-if="content[model.id]?.locales">
            · {{ content[model.id].locales.length }} {{ content[model.id].locales.length === 1 ? 'locale' : 'locales' }}
          </span>
        </div>
      </div>
      <span class="icon-[annon--chevron-right] size-4 shrink-0 text-muted" aria-hidden="true" />
    </button>
  </div>
</template>
