/**
 * Usage alerts — tell the owner before, and when, a limit stops something.
 *
 * The billing screen showed 80 % and 100 % warnings, but only to an owner who
 * opened Settings › Billing. AI credits ran out with no word to anyone, and a
 * public form or comment limit turned site visitors away while the owner
 * learned about it from a lost lead. This job emails the workspace owner once
 * per meter, counting period and threshold:
 *
 * - 80 %  → `usage-warning`: what is left and when it resets.
 * - 100 % → `usage-limit-reached` when overage is off: what has stopped, and
 *           until when. Or `usage-overage-started` when overage is on: usage
 *           continues and is billed at the unit price.
 *
 * Numbers come from `computeWorkspaceUsage`, the same computation as the
 * billing screen, so the email and the screen never disagree.
 *
 * CDN bandwidth is left out on purpose: its limit is not enforced today and
 * the policy is still open (PRC-2). An email saying delivery "has stopped"
 * would be false.
 *
 * Send is at most once per key: the row is claimed first (primary key), the
 * email goes out only if this run won the claim, and a failed send releases it
 * so the next run retries.
 */
import { PLAN_PRICING, normalizePlan } from '../../shared/utils/license'
import type { DatabaseProvider, UsageAlertKey } from '../providers/database'
import { emailTemplate, errorMessage } from './content-strings'
import { getEffectivePlan } from './billing'
import type { PaymentAccountState } from './billing'
import { resolveOverageLocks } from './overage-lock'
import type { OverageLockAccount } from './overage-lock'
import { usagePeriodFrom } from './usage-period'
import type { UsagePeriodAccount } from './usage-period'
import { computeWorkspaceUsage } from './workspace-usage'
import type { WorkspaceUsageCategory } from './workspace-usage'

/** Meters that alert. CDN is excluded — see the header. */
const ALERTING_METERS = new Set(['ai_messages', 'api_messages', 'mcp_calls', 'form_submissions', 'comments', 'media_storage'])

export interface PlannedAlert {
  category: WorkspaceUsageCategory
  threshold: 80 | 100
  template: 'usage-warning' | 'usage-limit-reached' | 'usage-overage-started'
}

/** Which alert, if any, each meter is due. Pure. */
export function planUsageAlerts(categories: WorkspaceUsageCategory[]): PlannedAlert[] {
  const planned: PlannedAlert[] = []
  for (const category of categories) {
    if (!ALERTING_METERS.has(category.key)) continue
    // Unlimited (-1) or not included at all (0): nothing to warn about.
    if (category.limit <= 0) continue
    if (category.percentage >= 100) {
      planned.push({ category, threshold: 100, template: category.overageEnabled ? 'usage-overage-started' : 'usage-limit-reached' })
    }
    else if (category.percentage >= 80) {
      planned.push({ category, threshold: 80, template: 'usage-warning' })
    }
  }
  return planned
}

type AlertDatabase = Pick<DatabaseProvider,
  | 'listWorkspacesForUsageAlerts'
  | 'claimUsageAlert'
  | 'releaseUsageAlert'
  | 'getActivePaymentAccount'
  | 'getWorkspaceMonthlyAIUsage'
  | 'getWorkspaceMonthlyAPIUsage'
  | 'countMonthlySubmissions'
  | 'getWorkspaceMonthlyCDNBandwidth'
  | 'getWorkspaceMonthlyMcpCloudUsage'
  | 'countMonthlyComments'
>

export interface UsageAlertDeps {
  db: AlertDatabase
  sendEmail: (message: { to: string, subject: string, html: string }) => Promise<unknown>
  ownerEmail: (ownerId: string) => Promise<string | null>
  siteUrl: string
  now?: Date
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

function formatAmount(value: number, unit: string): string {
  return unit === 'GB' ? `${value.toFixed(1)} GB` : `${Math.round(value).toLocaleString('en-US')} ${unit}`
}

/** One sweep over every subscribed workspace. Returns what was sent. */
export async function runUsageAlerts(deps: UsageAlertDeps): Promise<Array<UsageAlertKey & { template: string }>> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const sent: Array<UsageAlertKey & { template: string }> = []

  for (const ws of await db.listWorkspacesForUsageAlerts()) {
    const workspaceId = ws.id as string
    const ownerId = ws.owner_id as string | null
    if (!ownerId) continue

    try {
      const account = await db.getActivePaymentAccount(workspaceId)
      // The plan the limits are enforced against — an expired trial is not Pro.
      const plan = getEffectivePlan({
        type: (ws.type as string) ?? 'team',
        plan: (ws.plan as string | null) ?? null,
        payment_account: (account as unknown as PaymentAccountState | null) ?? null,
      })
      const usage = await computeWorkspaceUsage(db, {
        workspaceId,
        plan,
        overageSettings: (ws.overage_settings as Record<string, boolean> | null) ?? {},
        storageBytes: Number(ws.media_storage_bytes ?? 0),
        period: usagePeriodFrom(account as UsagePeriodAccount | null, now),
        overageLocks: resolveOverageLocks(account as OverageLockAccount | null),
        now,
      })

      const alerts = planUsageAlerts(usage.categories)
      if (alerts.length === 0) continue
      const to = await deps.ownerEmail(ownerId)
      if (!to) continue

      const slug = (ws.slug as string | null) ?? workspaceId
      const billingUrl = `${deps.siteUrl}/w/${slug}/settings?tab=billing`
      const planName = PLAN_PRICING[normalizePlan(plan)]?.name ?? plan

      for (const alert of alerts) {
        const key: UsageAlertKey = { workspaceId, meter: alert.category.key, periodKey: alert.category.periodKey, threshold: alert.threshold }
        if (!(await db.claimUsageAlert(key))) continue
        const c = alert.category
        const tpl = emailTemplate(alert.template, {
          workspaceName: (ws.name as string | null) ?? slug,
          planName,
          meterName: c.name,
          percentage: c.percentage,
          used: formatAmount(c.current, c.unit),
          limit: formatAmount(c.limit, c.unit),
          resetDate: formatDate(c.resetsAt),
          consequence: errorMessage(`usage_alert.stopped_${c.key}`, { date: formatDate(c.resetsAt) }),
          unitPrice: `$${c.overageUnitPrice}`,
          billingUrl,
        })
        try {
          await deps.sendEmail({ to, subject: tpl.subject, html: tpl.body })
          sent.push({ ...key, template: alert.template })
        }
        catch (err) {
          await db.releaseUsageAlert(key).catch(() => {})
          // eslint-disable-next-line no-console -- scheduled job; the failure must surface
          console.error('[usage-alerts] send failed', workspaceId, key.meter, err)
        }
      }
    }
    catch (err) {
      // One workspace must not stop the sweep for the others.
      // eslint-disable-next-line no-console -- scheduled job; the failure must surface
      console.error('[usage-alerts] workspace failed', workspaceId, err)
    }
  }
  return sent
}
