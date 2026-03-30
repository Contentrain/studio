<script setup lang="ts">
const props = defineProps<{
  terms: [string, Record<string, string>][]
  locale: string
  editable?: boolean
}>()

const emit = defineEmits<{
  save: [terms: Record<string, Record<string, string> | null>]
}>()

const { t } = useContent()

const vocabNewKey = ref('')
const vocabNewValue = ref('')

function deleteTerm(key: string) {
  emit('save', { [key]: null })
}

function addTerm() {
  const key = vocabNewKey.value.trim()
  const value = vocabNewValue.value.trim()
  if (!key || !value) return
  emit('save', { [key]: { [props.locale]: value } })
  vocabNewKey.value = ''
  vocabNewValue.value = ''
}
</script>

<template>
  <div v-if="terms.length === 0 && !editable" class="p-5">
    <AtomsEmptyState
      icon="icon-[annon--book-library]"
      :title="t('content.vocabulary_empty_title')"
      :description="t('content.vocabulary_empty_description')"
    />
  </div>
  <template v-else>
    <div class="divide-y divide-secondary-100 dark:divide-secondary-800">
      <div
        v-for="[term, translations] in terms"
        :key="term"
        class="group/row flex items-center gap-3 px-5 py-2.5 hover:bg-secondary-50 dark:hover:bg-secondary-900"
      >
        <div class="min-w-0 flex-1">
          <div class="font-mono text-xs font-medium text-label">
            {{ term }}
          </div>
          <div class="mt-0.5 text-sm text-heading dark:text-secondary-100">
            {{ translations[locale] ?? (Object.keys(translations).length > 0 ? translations[Object.keys(translations)[0]!] : '—') }}
          </div>
          <div v-if="Object.keys(translations).length > 1" class="mt-0.5 flex gap-1.5">
            <span
              v-for="(_val, loc) in translations"
              :key="loc"
              class="text-[10px] text-muted"
              :class="{ 'font-medium text-primary-500': loc === locale }"
            >
              {{ String(loc).toUpperCase() }}
            </span>
          </div>
        </div>
        <button
          v-if="editable"
          type="button"
          class="shrink-0 rounded p-1 text-muted opacity-0 transition-[color,opacity] hover:text-danger-500 group-hover/row:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
          :title="t('vocabulary.delete_term')"
          @click="deleteTerm(term)"
        >
          <span class="icon-[annon--trash] block size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
    <!-- Add term -->
    <div v-if="editable" class="sticky bottom-0 border-t border-secondary-200 bg-white px-5 py-3 dark:border-secondary-800 dark:bg-secondary-950">
      <form class="flex items-center gap-2" @submit.prevent="addTerm">
        <input
          v-model="vocabNewKey"
          type="text"
          :placeholder="t('vocabulary.key_placeholder')"
          class="h-8 w-24 shrink-0 rounded-lg border border-secondary-200 bg-white px-2.5 text-xs font-mono text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
        >
        <input
          v-model="vocabNewValue"
          type="text"
          :placeholder="t('vocabulary.value_placeholder')"
          class="h-8 flex-1 rounded-lg border border-secondary-200 bg-white px-2.5 text-sm text-heading placeholder:text-disabled focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-secondary-700 dark:bg-secondary-900 dark:text-secondary-100"
        >
        <AtomsBaseButton
          type="submit"
          variant="primary"
          size="sm"
          :disabled="!vocabNewKey.trim() || !vocabNewValue.trim()"
        >
          <span class="icon-[annon--plus] size-3.5" aria-hidden="true" />
        </AtomsBaseButton>
      </form>
    </div>
  </template>
</template>
