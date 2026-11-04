/**
 * Year end of a prepaid Studio year (migrations 055/056), run every 6 hours by `plugins/migrate-prepaid-sweep.ts`.
 *
 * A prepaid year renews nothing by itself, so the owner is told before it ends and when it has:
 *   stage 1  T-30 (up to T-7)  "ends {date}, choose a plan to keep Studio"
 *   stage 2  T-7 (up to T0)     the same, a week out
 *   stage 3  the end            the year comes off the workspace (`endPrepaidYear`): with a "Keep Studio"
 *                               subscription, that subscription is the plan from now on and nothing is mailed;
 *                               without one, the plan falls back to free and the owner is told.
 * The cursor (`prepaid_reminder_stage`) is monotonic per grant, so a year that starts its last month already
 * past T-30 gets the T-7 mail only, and a missed run catches up on the next one. A year with a renewal
 * scheduled gets no "choose a plan" mail.
 */
import { STUDIO_YEARLY_LIST_CENTS } from '../../shared/utils/migrate-bundle'
import { PLAN_PRICING, normalizePlan } from '../../shared/utils/license'
import type { DatabaseProvider, DatabaseRow } from '../providers/database'
import type { EmailProvider } from '../providers/email'
import { emailTemplate } from './content-strings'
import { endPrepaidYear } from './migrate-revoke'

const DAY_MS = 24 * 60 * 60 * 1000

interface PrepaidWindow {
  stage: 1 | 2 | 3
  /** `prepaid_ends_at` bounds relative to now, in ms. */
  fromOffsetMs: number
  toOffsetMs: number
}

export const PREPAID_WINDOWS: PrepaidWindow[] = [
  { stage: 1, fromOffsetMs: 7.5 * DAY_MS, toOffsetMs: 30.5 * DAY_MS },
  { stage: 2, fromOffsetMs: 1, toOffsetMs: 7.5 * DAY_MS },
  // Ended: any end up to now (a year never comes back from stage 3).
  { stage: 3, fromOffsetMs: -100 * 365 * DAY_MS, toOffsetMs: 0 },
]

type SweepDb = Pick<DatabaseProvider, 'listPrepaidYearsDue' | 'setPrepaidReminderStage'>

export interface PrepaidSweepDeps {
  db: SweepDb
  email: Pick<EmailProvider, 'sendEmail'> | null
  ownerEmail: (ownerId: string) => Promise<string | null>
  siteUrl: string
  now?: Date
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })

function endsText(endsAt: string, now: Date): string {
  const days = Math.max(1, Math.round((new Date(endsAt).getTime() - now.getTime()) / DAY_MS))
  return days === 1 ? 'tomorrow' : `in ${days} days`
}

async function mail(deps: PrepaidSweepDeps, row: DatabaseRow, slug: 'prepaid-ending' | 'prepaid-ended', now: Date): Promise<void> {
  if (!deps.email || !row.owner_id) return
  const to = await deps.ownerEmail(String(row.owner_id))
  if (!to) return
  const workspaceSlug = String(row.workspace_slug ?? row.workspace_id)
  const endsAt = String(row.prepaid_ends_at)
  const tpl = emailTemplate(slug, {
    workspaceName: String(row.workspace_name ?? workspaceSlug),
    planName: PLAN_PRICING[normalizePlan(row.plan as string)]?.name ?? String(row.plan),
    endsDate: longDate(endsAt),
    endsText: endsText(endsAt, now),
    starterYearly: usd(STUDIO_YEARLY_LIST_CENTS.starter),
    proYearly: usd(STUDIO_YEARLY_LIST_CENTS.pro),
    billingUrl: `${deps.siteUrl}/w/${workspaceSlug}/settings?tab=billing`,
  })
  await deps.email.sendEmail({ to, subject: tpl.subject, html: tpl.html, text: tpl.text })
}

/** One pass. Returns what each year got, for the job's log line. */
export async function runPrepaidSweep(deps: PrepaidSweepDeps): Promise<{ reminded: number, ended: number, renewed: number }> {
  const now = deps.now ?? new Date()
  const summary = { reminded: 0, ended: 0, renewed: 0 }

  for (const window of PREPAID_WINDOWS) {
    const rows = await deps.db.listPrepaidYearsDue({
      from: new Date(now.getTime() + window.fromOffsetMs).toISOString(),
      to: new Date(now.getTime() + window.toOffsetMs).toISOString(),
      requiredStage: window.stage,
    })
    for (const row of rows) {
      const grantId = String(row.grant_id)
      try {
        if (window.stage < 3) {
          // A year that Studio continues after needs no "choose a plan" mail.
          if (!row.renewal_subscription_id) {
            await mail(deps, row, 'prepaid-ending', now)
            summary.reminded += 1
          }
          await deps.db.setPrepaidReminderStage(grantId, window.stage)
          continue
        }
        // The end: the year comes off first, so a mail failure never leaves it on.
        await endPrepaidYear(String(row.workspace_id), row.prepaid_ends_at)
        await deps.db.setPrepaidReminderStage(grantId, 3)
        if (row.renewal_subscription_id) {
          summary.renewed += 1
          continue
        }
        summary.ended += 1
        await mail(deps, row, 'prepaid-ended', now).catch((err: unknown) => {
          // eslint-disable-next-line no-console -- the plan has ended either way; the mail is not retried
          console.error('[prepaid-sweep] ended mail failed for workspace', row.workspace_id, err)
        })
      }
      catch (err) {
        // The stage is not advanced: the next run retries this year.
        // eslint-disable-next-line no-console -- log per-year failure without aborting the batch
        console.error('[prepaid-sweep] failed for grant', grantId, err)
      }
    }
  }
  return summary
}
