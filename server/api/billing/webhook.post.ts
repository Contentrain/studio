/**
 * POST /api/billing/webhook
 *
 * Stripe webhook handler.
 * Processes subscription lifecycle events and updates workspace billing state.
 *
 * This route is public (no auth middleware) — Stripe sends webhooks directly.
 * Security is via Stripe signature verification.
 *
 * Events handled:
 * - checkout.session.completed — new subscription (trial starts)
 * - customer.subscription.updated — status/plan changes (trial→active, etc.)
 * - customer.subscription.deleted — subscription permanently removed
 * - invoice.creating — add overage line items before invoice is finalized
 * - invoice.payment_failed — charge failed, begin grace period
 * - invoice.paid — charge succeeded, clear grace period
 */

import { calculateAndBillOverages } from '../../utils/overage-billing'

export default defineEventHandler(async (event) => {
  const body = await readRawBody(event)
  const signature = getRequestHeader(event, 'stripe-signature')

  if (!body || !signature) {
    throw createError({ statusCode: 400, message: 'Missing webhook payload or signature.' })
  }

  const payment = usePaymentProvider()
  if (!payment) {
    throw createError({ statusCode: 503, message: 'Billing is not configured.' })
  }

  let result
  try {
    result = await payment.handleWebhook(body, signature)
  }
  catch {
    throw createError({ statusCode: 400, message: 'Webhook signature verification failed.' })
  }

  const db = useDatabaseProvider()

  switch (result.event) {
    case 'checkout.session.completed': {
      if (result.workspaceId && result.plan) {
        // New subscription created — set plan, store Stripe IDs, set trial state.
        // trial_ends_at is derived from Stripe's trial_period_end (via currentPeriodEnd during trialing).
        const updates: Record<string, unknown> = {
          plan: result.plan,
          stripe_customer_id: result.customerId,
          stripe_subscription_id: result.subscriptionId,
          subscription_status: result.subscriptionStatus ?? 'trialing',
          subscription_cancel_at_period_end: result.cancelAtPeriodEnd ?? false,
          grace_period_ends_at: null,
        }

        // During trial: currentPeriodEnd = trial end date
        if (result.subscriptionStatus === 'trialing' && result.currentPeriodEnd) {
          updates.trial_ends_at = result.currentPeriodEnd
          updates.subscription_current_period_end = result.currentPeriodEnd
        }
        else {
          updates.trial_ends_at = null
          updates.subscription_current_period_end = result.currentPeriodEnd ?? null
        }

        await db.updateWorkspace('', result.workspaceId, updates)
      }
      break
    }

    case 'customer.subscription.updated': {
      if (result.workspaceId) {
        const updates: Record<string, unknown> = {
          subscription_status: result.subscriptionStatus,
          subscription_current_period_end: result.currentPeriodEnd ?? null,
          subscription_cancel_at_period_end: result.cancelAtPeriodEnd ?? false,
        }

        // Update plan if changed (e.g., upgrade/downgrade)
        if (result.plan) {
          updates.plan = result.plan
        }

        // Trial ended → subscription became active: clear trial_ends_at.
        // Reset the reminder stage too so a future trial (if any — e.g.
        // customer cancels, comes back later) starts the sequence fresh.
        if (result.subscriptionStatus === 'active') {
          updates.trial_ends_at = null
          updates.grace_period_ends_at = null
          updates.trial_reminder_stage = 0
        }

        await db.updateWorkspace('', result.workspaceId, updates)
      }
      break
    }

    case 'customer.subscription.deleted': {
      if (result.workspaceId) {
        // Subscription permanently removed — downgrade to free
        await db.updateWorkspace('', result.workspaceId, {
          plan: 'free',
          subscription_status: null,
          stripe_subscription_id: null,
          subscription_current_period_end: null,
          subscription_cancel_at_period_end: false,
          trial_ends_at: null,
          grace_period_ends_at: null,
          trial_reminder_stage: 0,
        })
      }
      break
    }

    case 'invoice.creating': {
      // Add overage line items before Stripe finalizes the invoice.
      if (result.workspaceId && result.subscriptionId && result.customerId) {
        await calculateAndBillOverages(
          result.workspaceId,
          result.customerId,
          result.subscriptionId,
        )
      }
      break
    }

    case 'invoice.payment_failed': {
      // Payment failed — set 7-day grace period (only on first failure)
      const workspaceId = result.workspaceId
      if (workspaceId) {
        const workspace = await db.getWorkspaceById(workspaceId, 'grace_period_ends_at')
        const existing = (workspace as { grace_period_ends_at?: string | null } | null)?.grace_period_ends_at

        // Only set grace period on first failure (don't extend on subsequent failures)
        if (!existing) {
          const gracePeriodEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          await db.updateWorkspace('', workspaceId, {
            subscription_status: 'past_due',
            grace_period_ends_at: gracePeriodEnd,
          })
        }
        else {
          await db.updateWorkspace('', workspaceId, {
            subscription_status: 'past_due',
          })
        }
      }
      break
    }

    case 'invoice.paid': {
      // Payment succeeded — clear grace period.
      // Only set 'active' if the workspace was past_due (recovery).
      // Do NOT override 'trialing' — Stripe sends invoice.paid for $0 trial invoices.
      if (result.workspaceId) {
        const ws = await db.getWorkspaceById(result.workspaceId, 'subscription_status')
        const currentStatus = (ws as { subscription_status?: string } | null)?.subscription_status

        if (currentStatus === 'past_due') {
          await db.updateWorkspace('', result.workspaceId, {
            subscription_status: 'active',
            grace_period_ends_at: null,
          })
        }
        else if (currentStatus !== 'trialing') {
          // For non-trialing, non-past_due: just clear grace period if any
          await db.updateWorkspace('', result.workspaceId, {
            grace_period_ends_at: null,
          })
        }
        // If trialing: do nothing — let subscription.updated handle trial→active transition
      }
      break
    }
  }

  // Always return 200 to acknowledge receipt
  return { received: true }
})
