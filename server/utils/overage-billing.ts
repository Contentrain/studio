/**
 * Overage billing engine.
 *
 * Calculates and bills overages via Stripe invoice items.
 * Called from the `invoice.creating` webhook handler — Stripe fires this
 * event before finalizing an invoice, giving us a window to add line items.
 *
 * Safety: Uses overage_billing_log with UNIQUE constraint to prevent double-billing.
 */

import { OVERAGE_PRICING, getPlanLimitForPlan, normalizePlan } from '../../shared/utils/license'
import { calculateOverageUnits } from './overage'

/**
 * Calculate and bill overages for a workspace.
 *
 * For each enabled overage category:
 * 1. Queries actual usage for the billing period
 * 2. Computes overage = max(0, usage - planLimit)
 * 3. Checks overage_billing_log to avoid double-billing
 * 4. Creates Stripe invoice item if overage > 0
 * 5. Logs the billing entry for audit
 */
export async function calculateAndBillOverages(
  workspaceId: string,
  stripeCustomerId: string,
  stripeSubscriptionId: string,
): Promise<void> {
  const db = useDatabaseProvider()
  const payment = usePaymentProvider()
  if (!payment) return

  const workspace = await db.getWorkspaceById(workspaceId, 'plan, overage_settings, media_storage_bytes')
  if (!workspace) return

  const plan = normalizePlan(workspace.plan as string | null)
  const overageSettings = (workspace.overage_settings as Record<string, boolean>) ?? {}

  // Determine the billing period (previous month — invoice is for work already done)
  const now = new Date()
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const billingPeriod = prevMonth.toISOString().substring(0, 7)

  for (const [limitKey, pricing] of Object.entries(OVERAGE_PRICING)) {
    if (overageSettings[pricing.settingsKey] !== true) continue

    const planLimit = getPlanLimitForPlan(plan, limitKey)
    if (planLimit === Infinity) continue

    // Check if already billed (UNIQUE constraint also guards, but early exit saves queries)
    const alreadyBilled = await db.hasOverageBeenBilled(workspaceId, billingPeriod, pricing.settingsKey)
    if (alreadyBilled) continue

    // Get usage for the billing period
    const usage = await getUsageForCategory(db, workspaceId, limitKey, billingPeriod)
    const overageUnits = calculateOverageUnits(usage, planLimit)
    if (overageUnits <= 0) continue

    const totalCents = Math.round(overageUnits * pricing.price * 100)
    if (totalCents <= 0) continue

    try {
      // Add line item to the upcoming Stripe invoice
      const { invoiceItemId } = await payment.addInvoiceItem({
        customerId: stripeCustomerId,
        subscriptionId: stripeSubscriptionId,
        description: `Overage: ${Math.round(overageUnits * 100) / 100} ${pricing.unit}(s) over ${limitKey.replace('.', ' ')} limit`,
        amount: totalCents,
        metadata: {
          workspace_id: workspaceId,
          category: pricing.settingsKey,
          billing_period: billingPeriod,
          overage_units: String(Math.round(overageUnits * 100) / 100),
          unit_price: String(pricing.price),
        },
      })

      // Log to prevent double-billing
      await db.createOverageBillingEntry({
        workspaceId,
        billingPeriod,
        category: pricing.settingsKey,
        unitsBilled: overageUnits,
        unitPrice: pricing.price,
        totalAmount: overageUnits * pricing.price,
        stripeInvoiceItemId: invoiceItemId,
      })
    }
    catch (err) {
      // Log but don't throw — we don't want to block invoice finalization.
      // The UNIQUE constraint ensures we can retry safely on the next invoice event.
      // eslint-disable-next-line no-console -- intentional: log billing failure without blocking invoice finalization
      console.error(`[overage-billing] Failed to bill overage for ${pricing.settingsKey} in ${billingPeriod}:`, err)
    }
  }
}

/**
 * Get usage for a specific limit category.
 * Dispatches to the appropriate DatabaseProvider method based on limitKey.
 */
async function getUsageForCategory(
  db: ReturnType<typeof useDatabaseProvider>,
  workspaceId: string,
  limitKey: string,
  billingPeriod: string,
): Promise<number> {
  switch (limitKey) {
    case 'ai.messages_per_month':
      return db.getWorkspaceMonthlyAIUsage(workspaceId, billingPeriod)
    case 'api.messages_per_month':
      return db.getWorkspaceMonthlyAPIUsage(workspaceId, billingPeriod)
    case 'forms.submissions_per_month':
      return db.countMonthlySubmissions(workspaceId)
    case 'cdn.bandwidth_gb': {
      const bytes = await db.getWorkspaceMonthlyCDNBandwidth(workspaceId, billingPeriod)
      return bytes / (1024 * 1024 * 1024) // Convert to GB
    }
    case 'media.storage_gb': {
      // Storage is point-in-time, not monthly accumulated
      const ws = await db.getWorkspaceById(workspaceId, 'media_storage_bytes')
      const bytes = (ws?.media_storage_bytes as number) ?? 0
      return bytes / (1024 * 1024 * 1024) // Convert to GB
    }
    default:
      return 0
  }
}
