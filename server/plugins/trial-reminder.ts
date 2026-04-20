/**
 * Trial ending reminder scheduler — Nitro plugin.
 *
 * Runs every 6 hours: queries trialing workspaces whose `trial_ends_at`
 * falls inside the T-3 / T-1 / T-0 windows and whose monotonic
 * `trial_reminder_stage` has not yet advanced past that step. Each
 * match receives a templated email (`trial-ending`) and its stage is
 * bumped so subsequent runs don't re-send.
 *
 * Deliberately simple — we don't react to Stripe's
 * `customer.subscription.trial_will_end` event even though Stripe
 * fires it at T-3, because:
 *
 *   - Stripe only covers T-3. T-1 and T-0 need our own scheduling.
 *   - A single code path for all three reminders keeps the sequence
 *     idempotent and trivially recoverable if the Nitro process
 *     restarted during a run.
 *
 * The cron uses `useEmailProvider()` and silently no-ops when Resend
 * is not configured (self-hosted deployments without outbound email).
 */
import { emailTemplate } from '../utils/content-strings'
import { PLAN_PRICING } from '../../shared/utils/license'
import { useAuthProvider, useDatabaseProvider, useEmailProvider } from '../utils/providers'

const INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
const DAY_MS = 24 * 60 * 60 * 1000

interface ReminderWindow {
  /** Stage number recorded after send (1, 2 or 3). */
  stage: 1 | 2 | 3
  /** Lower bound of `trial_ends_at` relative to now, in ms (inclusive). */
  fromOffsetMs: number
  /** Upper bound of `trial_ends_at` relative to now, in ms (inclusive). */
  toOffsetMs: number
  /** Label used in the email subject/body ("in 3 days", "in 1 day", "today"). */
  trialEndsText: string
}

const WINDOWS: ReminderWindow[] = [
  // T-3: trial ends roughly 3 days from now
  { stage: 1, fromOffsetMs: 2.5 * DAY_MS, toOffsetMs: 3.5 * DAY_MS, trialEndsText: 'in 3 days' },
  // T-1: trial ends roughly 1 day from now
  { stage: 2, fromOffsetMs: 0.5 * DAY_MS, toOffsetMs: 1.5 * DAY_MS, trialEndsText: 'tomorrow' },
  // T-0: trial_ends_at inside a ±6h window around now
  { stage: 3, fromOffsetMs: -6 * 60 * 60 * 1000, toOffsetMs: 6 * 60 * 60 * 1000, trialEndsText: 'today' },
]

export default defineNitroPlugin((nitroApp) => {
  // Initial fire after a short delay so Nitro finishes booting other
  // plugins (auth, DB pool) before the first run.
  setTimeout(() => runTrialReminders().catch(logFailure), 30_000)

  const interval = setInterval(() => {
    runTrialReminders().catch(logFailure)
  }, INTERVAL_MS)

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- scheduled background job; failure must surface somewhere
  console.error('[trial-reminder] Scheduled run failed:', err)
}

async function runTrialReminders(): Promise<void> {
  const db = useDatabaseProvider()
  const email = useEmailProvider()
  if (!email) return // self-hosted without Resend — skip silently

  const auth = useAuthProvider()
  const config = useRuntimeConfig()
  const siteUrl = (config.public as { siteUrl?: string } | null)?.siteUrl ?? ''

  const now = Date.now()

  for (const window of WINDOWS) {
    const from = new Date(now + window.fromOffsetMs).toISOString()
    const to = new Date(now + window.toOffsetMs).toISOString()

    const workspaces = await db.listWorkspacesPendingTrialReminder({
      from,
      to,
      requiredStage: window.stage,
    })

    for (const ws of workspaces) {
      const ownerId = ws.owner_id as string | null
      if (!ownerId) continue

      const user = await auth.getUserById(ownerId).catch(() => null)
      if (!user?.email) continue

      const plan = (ws.plan as string | null) ?? 'starter'
      const planPricing = PLAN_PRICING[plan as keyof typeof PLAN_PRICING] ?? PLAN_PRICING.starter
      const slug = (ws.slug as string | null) ?? (ws.id as string)

      const tpl = emailTemplate('trial-ending', {
        workspaceName: (ws.name as string | null) ?? planPricing.name,
        planName: planPricing.name,
        planPrice: `$${planPricing.priceMonthly}`,
        trialEndsText: window.trialEndsText,
        billingUrl: siteUrl ? `${siteUrl}/w/${slug}/settings?tab=billing` : `/w/${slug}/settings?tab=billing`,
      })

      try {
        await email.sendEmail({
          to: user.email,
          subject: tpl.subject,
          html: tpl.body,
        })
        await db.setTrialReminderStage(ws.id as string, window.stage)
      }
      catch (err) {
        // Don't advance the stage on failure — next run will retry.
        // eslint-disable-next-line no-console -- log per-workspace failure without aborting the batch
        console.error('[trial-reminder] Failed to send reminder to workspace', ws.id, err)
      }
    }
  }
}
