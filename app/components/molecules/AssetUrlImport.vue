<script setup lang="ts">
const props = defineProps<{
  workspaceId: string
  projectId: string
}>()

const emit = defineEmits<{
  imported: [report: { succeeded: number, failed: number }]
}>()

const { t } = useContent()
const toast = useToast()

const open = ref(false)
const text = ref('')
const busy = ref(false)
const failures = ref<Array<{ url: string, error?: string }>>([])

const urls = computed(() => text.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean))

async function run() {
  if (urls.value.length === 0 || busy.value) return
  busy.value = true
  failures.value = []
  try {
    const report = await $fetch<{ succeeded: number, failed: number, results: Array<{ url: string, ok: boolean, error?: string }> }>(
      `/api/workspaces/${props.workspaceId}/projects/${props.projectId}/media/bulk-ingest`,
      { method: 'POST', body: { items: urls.value.slice(0, 100).map(url => ({ url })) } },
    )
    failures.value = report.results.filter(r => !r.ok).map(r => ({ url: r.url, error: r.error }))
    toast.success(t('media.url_import_done', { succeeded: report.succeeded, failed: report.failed }))
    emit('imported', { succeeded: report.succeeded, failed: report.failed })
    if (report.failed === 0) {
      text.value = ''
      open.value = false
    }
    else {
      text.value = failures.value.map(f => f.url).join('\n')
    }
  }
  catch {
    toast.error(t('media.url_import_failed'))
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="px-4 pb-2">
    <button
      type="button"
      class="rounded text-xs font-medium text-primary-600 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400"
      :aria-expanded="open"
      @click="open = !open"
    >
      {{ open ? t('media.url_import_close') : t('media.url_import_open') }}
    </button>

    <div v-if="open" class="mt-2 space-y-2">
      <AtomsFormLabel for="asset-url-import">
        {{ t('media.url_import_label') }}
      </AtomsFormLabel>
      <p class="text-xs text-muted">
        {{ t('media.url_import_description') }}
      </p>
      <AtomsFormTextarea
        id="asset-url-import"
        :model-value="text"
        :rows="4"
        :placeholder="'https://old-site.example/wp-content/uploads/2020/05/hero.jpg'"
        :disabled="busy"
        @update:model-value="text = $event"
      />
      <div class="flex items-center justify-between">
        <span class="text-xs text-muted">{{ t('media.url_import_count', { count: Math.min(urls.length, 100) }) }}</span>
        <AtomsBaseButton type="button" variant="primary" size="sm" :disabled="busy || urls.length === 0" @click="run">
          {{ busy ? t('common.loading') : t('media.url_import_run') }}
        </AtomsBaseButton>
      </div>
      <ul v-if="failures.length" class="max-h-32 space-y-0.5 overflow-y-auto text-xs text-danger-600 dark:text-danger-400" role="alert">
        <li v-for="f in failures" :key="f.url" class="truncate">
          {{ f.url }}<span v-if="f.error"> — {{ f.error }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
