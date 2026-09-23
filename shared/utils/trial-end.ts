/**
 * When a trialing subscription counts as over.
 *
 * The provider ends a trial by charging the card and sending a webhook that
 * moves the subscription to `active` (or `past_due`, which has its own
 * grace). Until that webhook lands, the row still says `trialing` with a
 * `trial_ends_at` in the past. Reading that as "expired" the moment the
 * clock passes locks a customer who is being charged out of the product —
 * and, on the public surfaces (forms, comments, chatbot, MCP), takes their
 * live site's features down — because a delivery was late.
 *
 * So the trial keeps running for a short while past its end. Nothing extra
 * is sold meanwhile: the status is still `trialing`, so overage stays
 * locked and trial-only gates (e.g. premium models) stay on. A canceled
 * trial is not affected — the provider ends it with its own event.
 */
export const TRIAL_END_TOLERANCE_MS = 24 * 60 * 60 * 1000

export function isTrialOver(trialEndsAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!trialEndsAt) return false
  const end = new Date(trialEndsAt).getTime()
  if (Number.isNaN(end)) return false
  return end + TRIAL_END_TOLERANCE_MS <= now
}
