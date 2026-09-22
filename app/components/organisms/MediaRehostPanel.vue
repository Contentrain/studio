<script setup lang="ts">
/**
 * "Move media addresses" (#321): rewrite the previous instance's / project's
 * media URLs in content to this project, in one commit. Preview first; the
 * commit button unlocks only for a preview of the same inputs with nothing
 * missing. Owner/admin only — the server enforces it too.
 */
const props = defineProps<{
  workspaceId: string
  projectId: string
}>()

const { t } = useContent()
const toast = useToast()

interface RehostCounts {
  from: string
  to: string
  filesScanned: number
  filesChanged: number
  references: number
  mediaPaths: number
  missing: string[]
  copy: { requested: boolean, toCopy: number, copied: number, failed: string[] }
  library: { toAdd: number, existing: number, added: number }
}

interface RehostResponse {
  status: 'dry_run' | 'nothing_to_do' | 'committed'
  counts: RehostCounts
  pullRequestUrl?: string | null
}

const MISSING_SHOWN = 20

const fromSiteUrl = ref('')
const fromProjectId = ref('')
const copyAssets = ref(false)
const running = ref<'preview' | 'apply' | null>(null)
const preview = ref<RehostCounts | null>(null)
const previewKey = ref('')
const pullRequestUrl = ref<string | null>(null)

const inputKey = computed(() => JSON.stringify([fromSiteUrl.value.trim(), fromProjectId.value.trim(), copyAssets.value]))
const canPreview = computed(() => !running.value && !!fromSiteUrl.value.trim() && !!fromProjectId.value.trim())
const canApply = computed(() =>
  !running.value
  && preview.value !== null
  && previewKey.value === inputKey.value
  && preview.value.missing.length === 0
  && preview.value.filesChanged > 0,
)

function request(dryRun: boolean) {
  return $fetch<RehostResponse>(`/api/workspaces/${props.workspaceId}/projects/${props.projectId}/media/rehost`, {
    method: 'POST',
    body: {
      from: { siteUrl: fromSiteUrl.value.trim(), projectId: fromProjectId.value.trim() },
      dryRun,
      copyAssets: copyAssets.value,
    },
  })
}

async function runPreview() {
  running.value = 'preview'
  pullRequestUrl.value = null
  try {
    const result = await request(true)
    preview.value = result.counts
    previewKey.value = inputKey.value
  }
  catch (e) {
    preview.value = null
    toast.error(resolveApiError(e, t('media_rehost.error')))
  }
  finally {
    running.value = null
  }
}

async function runApply() {
  running.value = 'apply'
  try {
    const result = await request(false)
    preview.value = result.counts
    pullRequestUrl.value = result.pullRequestUrl ?? null
    // The addresses now point here — a second run would find nothing.
    previewKey.value = ''
    toast.success(t('media_rehost.success', { references: result.counts.references }))
  }
  catch (e) {
    // 409 carries the counts: missing files, a failed copy or library insert,
    // or a concurrent content change.
    const counts = (e as { data?: { data?: RehostCounts } }).data?.data
    if (counts) preview.value = counts
    toast.error(resolveApiError(e, t('media_rehost.error')))
  }
  finally {
    running.value = null
  }
}
</script>

<template>
  <div class="space-y-5 px-6 py-5">
    <div class="flex items-start gap-3">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-900/20">
        <span class="icon-[annon--image] size-4 text-primary-500" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold text-heading dark:text-secondary-100">
          {{ t('media_rehost.title') }}
        </h3>
        <p class="mt-0.5 text-xs text-muted">
          {{ t('media_rehost.description') }}
        </p>
      </div>
    </div>

    <div class="space-y-3">
      <div>
        <AtomsFormLabel for="media-rehost-site" :text="t('media_rehost.from_site_url')" size="sm" />
        <AtomsFormInput
          id="media-rehost-site"
          v-model="fromSiteUrl"
          type="url"
          :placeholder="t('media_rehost.from_site_url_placeholder')"
          class="mt-1.5"
        />
      </div>
      <div>
        <AtomsFormLabel for="media-rehost-project" :text="t('media_rehost.from_project_id')" size="sm" />
        <AtomsFormInput
          id="media-rehost-project"
          v-model="fromProjectId"
          class="mt-1.5"
        />
      </div>
      <div>
        <AtomsFormSwitch v-model="copyAssets" :label="t('media_rehost.copy_assets')" />
        <p class="mt-1 text-xs text-muted">
          {{ t('media_rehost.copy_assets_hint') }}
        </p>
      </div>
    </div>

    <div
      v-if="preview"
      class="space-y-2 rounded-lg border border-secondary-200 bg-secondary-50 px-4 py-3 text-xs dark:border-secondary-800 dark:bg-secondary-900"
      aria-live="polite"
    >
      <p v-if="preview.references === 0" class="text-body dark:text-secondary-300">
        {{ t('media_rehost.nothing_found') }}
      </p>
      <p v-else class="text-body dark:text-secondary-300">
        {{ t('media_rehost.summary', { references: preview.references, paths: preview.mediaPaths, files: preview.filesChanged, scanned: preview.filesScanned }) }}
      </p>
      <p v-if="preview.copy.requested && preview.copy.toCopy > 0" class="text-body dark:text-secondary-300">
        {{ t('media_rehost.to_copy', { count: preview.copy.toCopy }) }}
      </p>
      <p v-if="preview.copy.requested" class="text-body dark:text-secondary-300">
        {{ t('media_rehost.library_rows', { add: preview.library.toAdd, existing: preview.library.existing }) }}
      </p>
      <template v-if="preview.missing.length > 0">
        <p class="font-medium text-danger-600 dark:text-danger-400">
          {{ t('media_rehost.missing_title', { count: preview.missing.length }) }}
        </p>
        <p class="text-muted">
          {{ t('media_rehost.missing_hint') }}
        </p>
        <ul class="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px] text-body dark:text-secondary-300">
          <li v-for="path in preview.missing.slice(0, MISSING_SHOWN)" :key="path" class="truncate" :title="path">
            {{ path }}
          </li>
          <li v-if="preview.missing.length > MISSING_SHOWN" class="text-muted">
            {{ t('media_rehost.missing_more', { count: preview.missing.length - MISSING_SHOWN }) }}
          </li>
        </ul>
      </template>
      <p v-else-if="preview.references > 0" class="text-success-600 dark:text-success-400">
        {{ t('media_rehost.all_present') }}
      </p>
      <a
        v-if="pullRequestUrl"
        :href="pullRequestUrl"
        target="_blank"
        rel="noopener"
        class="inline-block rounded text-primary-600 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400"
      >
        {{ t('media_rehost.view_pr') }}
      </a>
    </div>

    <div class="flex items-center justify-end gap-2">
      <AtomsBaseButton variant="secondary" size="sm" :disabled="!canPreview" @click="runPreview">
        {{ running === 'preview' ? t('media_rehost.previewing') : t('media_rehost.preview') }}
      </AtomsBaseButton>
      <AtomsBaseButton variant="primary" size="sm" :disabled="!canApply" @click="runApply">
        {{ running === 'apply' ? t('media_rehost.applying') : t('media_rehost.apply') }}
      </AtomsBaseButton>
    </div>
  </div>
</template>
