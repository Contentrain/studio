<script setup lang="ts">
import type { UsageCategory } from '~/composables/useUsage'
import { CDN_ORIGIN_HARD_STOP_RATIO } from '~~/shared/utils/cdn-limit'

/**
 * Usage notice for the whole workspace — 80 % and limit-reached, wherever
 * the user is.
 *
 * The same warnings used to live only inside Settings › Billing, for an owner
 * who opened it. A limit that stops something — Studio AI, the site's forms
 * or comments — went unseen: forms and comments fail for the site visitor,
 * never for anyone in Studio. This says what has stopped and until when.
 *
 * Owners and admins get the 80 % warning too, with a link to Billing. Members
 * only hear about limits that stop something, and who can change them.
 *
 * CDN bandwidth has a buffer: past its limit delivery continues (a grace
 * notice with the upgrade link, owners and admins) and it stops only at
 * `CDN_ORIGIN_HARD_STOP_RATIO` of the limit.
 */

const { t } = useContent()
const { usage, fetchUsage } = useUsage()
const { activeWorkspace } = useWorkspaces()
const { isOwnerOrAdmin } = useWorkspaceRole()

const ALERTING = ['ai_messages', 'form_submissions', 'comments', 'api_messages', 'mcp_calls', 'media_storage', 'cdn_bandwidth']

/** Where a meter stops: its limit, or the CDN's hard stop past it. */
function stopAt(c: UsageCategory): number {
  return c.key === 'cdn_bandwidth' ? c.limit * CDN_ORIGIN_HARD_STOP_RATIO : c.limit
}
/** CDN between its limit and the hard stop: still serving. */
function inGrace(c: UsageCategory): boolean {
  return c.key === 'cdn_bandwidth' && !c.overageEnabled && c.current >= c.limit && c.current < stopAt(c)
}

watch(() => activeWorkspace.value?.id, (id) => {
  if (id) fetchUsage().catch(() => {})
}, { immediate: true })

const relevant = computed(() =>
  (usage.value?.categories ?? []).filter(c => ALERTING.includes(c.key) && c.limit > 0),
)
/** At the limit with nothing billed past it: this has stopped. */
// Raw values, not the rounded percentage: 995 / 1000 shows 100 % but nothing has stopped.
const stopped = computed(() => relevant.value.filter(c => c.current >= stopAt(c) && !c.overageEnabled))
const warnings = computed(() => isOwnerOrAdmin.value
  ? relevant.value.filter(c => (c.current >= c.limit * 0.8 && c.current < c.limit) || inGrace(c))
  : [])
const alerts = computed(() => [...stopped.value, ...warnings.value])
const primary = computed<UsageCategory | null>(() => alerts.value[0] ?? null)

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

const text = computed(() => {
  const c = primary.value
  if (!c) return ''
  const date = c.resetsAt ? formatDate(c.resetsAt) : ''
  if (inGrace(c)) return t('usage_banner.grace_cdn_bandwidth', { percentage: Math.round(CDN_ORIGIN_HARD_STOP_RATIO * 100) })
  if (c.current >= stopAt(c)) return t(`usage_banner.stopped_${c.key}` as never, { date })
  return date
    ? t('usage_banner.warning', { name: c.name, percentage: c.percentage, date })
    : t('usage_banner.warning_undated', { name: c.name, percentage: c.percentage })
})

const isStop = computed(() => !!primary.value && primary.value.current >= stopAt(primary.value) && !primary.value.overageEnabled)

const billingPath = computed(() => {
  const slug = activeWorkspace.value?.slug
  return slug ? `/w/${slug}/settings?tab=billing` : null
})

/** Dismissal lasts for this exact set of alerts; a new alert shows again. */
const DISMISS_KEY = 'contentrain-usage-banner-dismissed'
const signature = computed(() => alerts.value.map(c => `${c.key}:${c.current >= stopAt(c) ? 'stop' : c.current >= c.limit ? 100 : 80}`).join(','))

/** Storage can be unavailable (private mode, blocked site data): the banner must still render. */
function readDismissed(): string | null {
  if (!import.meta.client) return null
  try {
    return sessionStorage.getItem(DISMISS_KEY)
  }
  catch {
    return null
  }
}
const dismissed = ref<string | null>(readDismissed())
const isVisible = computed(() => !!primary.value && dismissed.value !== signature.value)

function dismiss() {
  dismissed.value = signature.value
  if (!import.meta.client) return
  try {
    sessionStorage.setItem(DISMISS_KEY, signature.value)
  }
  catch {
    // Dismissed for this page view only.
  }
}
</script>

<template>
  <div
    v-if="isVisible"
    role="status"
    class="flex w-full items-center gap-2 px-3 py-2 text-xs md:w-auto md:max-w-xl md:rounded-full md:border md:px-4 md:shadow-sm"
    :class="isStop
      ? 'bg-danger-50 text-danger-800 md:border-danger-200 dark:bg-danger-950/60 dark:text-danger-200 dark:md:border-danger-900'
      : 'bg-warning-50 text-warning-800 md:border-warning-200 dark:bg-warning-950/60 dark:text-warning-200 dark:md:border-warning-900'"
    data-testid="usage-alert-banner"
  >
    <span class="icon-[annon--alert-triangle] size-4 shrink-0" aria-hidden="true" />
    <span class="min-w-0 flex-1">{{ text }}</span>
    <span v-if="alerts.length > 1" class="shrink-0 opacity-80">{{ t('usage_banner.more', { count: alerts.length - 1 }) }}</span>
    <NuxtLink
      v-if="isOwnerOrAdmin && billingPath"
      :to="billingPath"
      class="shrink-0 rounded-md px-2 py-0.5 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
    >
      {{ t('usage_banner.open_billing') }}
    </NuxtLink>
    <span v-else-if="!isOwnerOrAdmin" class="shrink-0">{{ t('billing.ask_owner') }}</span>
    <button
      type="button"
      class="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
      @click="dismiss"
    >
      <span class="icon-[annon--cross] block size-3.5" aria-hidden="true" />
      <span class="sr-only">{{ t('common.dismiss') }}</span>
    </button>
  </div>
</template>
