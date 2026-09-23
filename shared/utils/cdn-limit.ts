/**
 * CDN origin-transfer limit policy (`cdn.bandwidth_gb`).
 *
 * Delivery does not stop at the plan limit: between 100 % and this ratio it
 * keeps serving while the owner is told (usage alert + banner) and can
 * upgrade, so a busy day does not take a site down unannounced. At this
 * ratio the origin refuses (429 + Retry-After) until the month resets — the
 * overshoot Studio pays for is bounded to 20 % of the plan's transfer.
 * Shared by the delivery route, the usage alerts and the usage banner.
 */
export const CDN_ORIGIN_HARD_STOP_RATIO = 1.2
