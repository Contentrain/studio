/**
 * Client-side usage data composable.
 *
 * Fetches workspace usage metrics from the usage API endpoint
 * and provides overage toggle actions.
 */

export interface UsageCategory {
  key: string
  limitKey: string
  name: string
  current: number
  limit: number
  overageEnabled: boolean
  /** False → hard cap; extra usage is not sold for this category. */
  overageSellable?: boolean
  /**
   * Set → the subscription cannot bill overage yet (trial, or its prices
   * predate this meter). The toggle is off and disabled; `until` is when the
   * lock lifts on its own, null when it waits for a subscription update.
   */
  overageLock?: { reason: 'trialing' | 'not_in_subscription', until: string | null } | null
  overageUnits: number
  overageUnitPrice: number
  overageAmount: number
  unit: string
  percentage: number
  /** When this meter resets; null for a level that does not (storage). Absent from an older server. */
  resetsAt?: string | null
}

export interface UsagePeriodInfo {
  /** ISO instant the window opened. */
  startsAt: string
  /** ISO instant the counters reset. */
  resetsAt: string
  /** `billing` follows the subscription anniversary, `calendar` the 1st. */
  source: 'billing' | 'calendar'
}

export interface UsageData {
  billingPeriod: string
  /** Optional: absent from an older server response. */
  period?: UsagePeriodInfo
  /** False for members: meters only, no switches or amounts. Absent (= true) from an older server. */
  canManage?: boolean
  categories: UsageCategory[]
  /** AI turns run on members' own keys this period — outside the quota, not billed. Absent from an older server response. */
  byoaRequests?: number
  totalOverageAmount: number
  projectedOverageAmount: number
}

export function useUsage() {
  const { activeWorkspace } = useWorkspaces()
  const usage = ref<UsageData | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchUsage() {
    const ws = activeWorkspace.value
    if (!ws) return

    loading.value = true
    error.value = null
    try {
      usage.value = await $fetch<UsageData>(`/api/workspaces/${ws.id}/usage`)
    }
    catch (err: unknown) {
      error.value = (err as { data?: { message?: string } })?.data?.message ?? 'Failed to load usage data'
    }
    finally {
      loading.value = false
    }
  }

  async function toggleOverage(settingsKey: string, enabled: boolean) {
    const ws = activeWorkspace.value
    if (!ws) return

    await $fetch(`/api/workspaces/${ws.id}/overage-settings`, {
      method: 'PATCH',
      body: { [settingsKey]: enabled },
    })

    // Refresh usage to reflect new overage state
    await fetchUsage()
  }

  /** Categories approaching their limit (>= 80%). */
  const warnings = computed(() =>
    (usage.value?.categories ?? []).filter(c => c.percentage >= 80 && c.percentage < 100),
  )

  /** Categories at or past limit with overage disabled. */
  const limitReached = computed(() =>
    (usage.value?.categories ?? []).filter(c => c.percentage >= 100 && !c.overageEnabled),
  )

  /** Categories actively accruing overage charges. */
  const activeOverages = computed(() =>
    (usage.value?.categories ?? []).filter(c => c.overageUnits > 0),
  )

  return {
    usage: readonly(usage),
    loading: readonly(loading),
    error: readonly(error),
    fetchUsage,
    toggleOverage,
    warnings,
    limitReached,
    activeOverages,
  }
}
