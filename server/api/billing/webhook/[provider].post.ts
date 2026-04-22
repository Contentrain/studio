/**
 * POST /api/billing/webhook/:provider
 *
 * Per-provider webhook dispatcher. The provider key in the URL picks
 * the plugin; the plugin verifies the signature and normalises the
 * event to a canonical shape (`WebhookResult`). This handler then
 * applies the DB changes for all providers uniformly.
 *
 * Public route (no auth middleware); security comes from the plugin's
 * signature verification. Provider-specific signature headers are
 * carried through `handleWebhook`'s headers param.
 */

import { bootstrapPaymentPlugins, resolvePlugin } from '../../../providers/payment'
import type { PaymentPluginConfig } from '../../../providers/payment'
import { PLAN_PRICING, normalizePlan } from '../../../../shared/utils/license'
import { emailTemplate } from '../../../utils/content-strings'

/** Extract every request header as a plain `{[key]: string | undefined}` object. */
function readAllHeaders(event: Parameters<typeof getRequestHeaders>[0]): Record<string, string | undefined> {
  const raw = getRequestHeaders(event)
  const result: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(raw)) {
    result[key.toLowerCase()] = value
  }
  return result
}

/**
 * Dispatch a templated billing email to the workspace owner.
 *
 * Best-effort — a failed send is logged but never propagates, so the
 * webhook still acknowledges the provider even if Resend is down or
 * the workspace has no reachable owner. `workspaceName`, `planName`,
 * `planPrice`, and `billingUrl` are resolved centrally; the caller
 * supplies any extra per-template params.
 */
async function sendBillingEmail(
  workspaceId: string,
  templateSlug: string,
  planHint: string | null | undefined,
  extraParams: Record<string, string | number> = {},
): Promise<void> {
  const email = useEmailProvider()
  if (!email) return

  const db = useDatabaseProvider()
  const auth = useAuthProvider()

  const ws = await db.getWorkspaceById(workspaceId, 'id, name, slug, owner_id, plan').catch(() => null)
  if (!ws) return

  const ownerId = ws.owner_id as string | null
  if (!ownerId) return

  const user = await auth.getUserById(ownerId).catch(() => null)
  if (!user?.email) return

  const config = useRuntimeConfig()
  const siteUrl = (config.public as { siteUrl?: string } | null)?.siteUrl ?? ''
  const wsSlug = (ws.slug as string | null) ?? workspaceId
  const billingUrl = siteUrl
    ? `${siteUrl}/w/${wsSlug}/settings?tab=billing`
    : `/w/${wsSlug}/settings?tab=billing`

  const planKey = normalizePlan(planHint ?? (ws.plan as string | null))
  const pricing = PLAN_PRICING[planKey]

  const tpl = emailTemplate(templateSlug, {
    workspaceName: (ws.name as string | null) ?? wsSlug,
    planName: pricing.name,
    planPrice: pricing.priceMonthly > 0 ? `$${pricing.priceMonthly}` : 'custom pricing',
    billingUrl,
    ...extraParams,
  })

  await email.sendEmail({
    to: user.email,
    subject: tpl.subject,
    html: tpl.body,
  }).catch((err) => {
    // eslint-disable-next-line no-console -- surface delivery failures without aborting the webhook
    console.error('[billing-webhook] Failed to send', templateSlug, 'email:', err)
  })
}

/** Format a timestamp for human-readable copy — e.g. "Tuesday, April 29". */
function formatFriendlyDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

export default defineEventHandler(async (event) => {
  const providerKey = getRouterParam(event, 'provider') ?? ''

  bootstrapPaymentPlugins()
  const plugin = resolvePlugin(providerKey)
  if (!plugin) {
    throw createError({ statusCode: 404, message: `Unknown payment provider: ${providerKey}` })
  }

  const config = useRuntimeConfig() as unknown as PaymentPluginConfig
  if (!plugin.isConfigured(config)) {
    throw createError({ statusCode: 503, message: `Provider ${providerKey} is not configured.` })
  }

  const body = await readRawBody(event)
  if (!body) {
    throw createError({ statusCode: 400, message: 'Missing webhook payload.' })
  }

  const provider = plugin.create(config)
  const headers = readAllHeaders(event)

  let result
  try {
    result = await provider.handleWebhook(body, headers)
  }
  catch {
    throw createError({ statusCode: 400, message: 'Webhook signature verification failed.' })
  }

  const db = useDatabaseProvider()

  switch (result.event) {
    case 'subscription.created': {
      // Fresh subscription — upsert the active account for this workspace.
      if (!result.workspaceId || !result.customerId) break
      await db.upsertPaymentAccount({
        workspaceId: result.workspaceId,
        provider: plugin.key,
        customerId: result.customerId,
        subscriptionId: result.subscriptionId ?? null,
        subscriptionStatus: result.subscriptionStatus ?? 'trialing',
        currentPeriodEnd: result.currentPeriodEnd ?? null,
        trialEndsAt: result.trialEndsAt ?? (result.subscriptionStatus === 'trialing' ? result.currentPeriodEnd ?? null : null),
        cancelAtPeriodEnd: result.cancelAtPeriodEnd ?? false,
        gracePeriodEndsAt: null,
        plan: result.plan ?? null,
        isActive: true,
      })
      if (result.plan) {
        await db.updateWorkspace('', result.workspaceId, { plan: result.plan })
      }
      // Only email on direct paid activation — trialing workspaces are
      // covered by the trial-reminder cron at T-3/T-1/T-0.
      if (result.subscriptionStatus === 'active') {
        await sendBillingEmail(result.workspaceId, 'subscription-activated', result.plan)
      }
      break
    }

    case 'subscription.updated': {
      if (!result.workspaceId || !result.customerId) break
      // Read the existing account BEFORE upsert so we can detect the
      // trial→active transition (the only update-shape worth emailing on).
      const existingAccount = await db.getActivePaymentAccount(result.workspaceId)
      const wasTrialing = (existingAccount?.subscription_status as string | undefined) === 'trialing'
      const becameActive = result.subscriptionStatus === 'active'
      await db.upsertPaymentAccount({
        workspaceId: result.workspaceId,
        provider: plugin.key,
        customerId: result.customerId,
        subscriptionId: result.subscriptionId ?? null,
        subscriptionStatus: result.subscriptionStatus ?? null,
        currentPeriodEnd: result.currentPeriodEnd ?? null,
        // Clear trial_ends_at when transitioning to active
        trialEndsAt: result.subscriptionStatus === 'trialing'
          ? result.trialEndsAt ?? result.currentPeriodEnd ?? null
          : null,
        cancelAtPeriodEnd: result.cancelAtPeriodEnd ?? false,
        gracePeriodEndsAt: becameActive ? null : undefined,
        plan: result.plan ?? null,
        isActive: true,
      })

      const workspaceUpdate: Record<string, unknown> = {}
      if (result.plan) workspaceUpdate.plan = result.plan
      // Reset reminder stage when trial→active so a future trial restarts the sequence.
      if (becameActive) workspaceUpdate.trial_reminder_stage = 0
      if (Object.keys(workspaceUpdate).length > 0) {
        await db.updateWorkspace('', result.workspaceId, workspaceUpdate)
      }
      // Trial→active is the only update-shape that deserves an email.
      // Plan swaps, quantity changes, card updates all flow through
      // subscription.updated too and would spam the owner otherwise.
      if (becameActive && wasTrialing) {
        await sendBillingEmail(result.workspaceId, 'subscription-activated', result.plan)
      }
      break
    }

    case 'subscription.canceled': {
      if (!result.workspaceId) break
      // Snapshot the plan BEFORE archive + downgrade so the email
      // reflects what was canceled, not the post-cancel "free" state.
      const priorAccount = await db.getActivePaymentAccount(result.workspaceId)
      const canceledPlan = result.plan ?? (priorAccount?.plan as string | null)
      await db.archiveActivePaymentAccount(result.workspaceId)
      await db.updateWorkspace('', result.workspaceId, {
        plan: 'free',
        trial_reminder_stage: 0,
      })
      await sendBillingEmail(result.workspaceId, 'subscription-canceled', canceledPlan)
      break
    }

    case 'invoice.payment_failed': {
      // Only the first failure sets a fresh grace window; subsequent
      // failures within the window leave the existing end-date intact.
      if (!result.workspaceId) break
      const account = await db.getActivePaymentAccount(result.workspaceId)
      if (!account) break
      const existingGrace = (account.grace_period_ends_at as string | null | undefined) ?? null
      const customerId = account.customer_id as string
      const provider = account.provider as string
      const gracePeriodEnd = existingGrace ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

      await db.upsertPaymentAccount({
        workspaceId: result.workspaceId,
        provider,
        customerId,
        subscriptionId: (account.subscription_id as string | null) ?? null,
        subscriptionStatus: 'past_due',
        currentPeriodEnd: (account.current_period_end as string | null) ?? null,
        trialEndsAt: (account.trial_ends_at as string | null) ?? null,
        cancelAtPeriodEnd: Boolean(account.cancel_at_period_end),
        gracePeriodEndsAt: gracePeriodEnd,
        plan: (account.plan as string | null) ?? null,
        isActive: true,
      })
      // Email only on the FIRST failure in a window — subsequent
      // failures carry the same existingGrace and would otherwise
      // re-spam the owner every retry cycle.
      if (!existingGrace) {
        await sendBillingEmail(
          result.workspaceId,
          'payment-failed',
          (account.plan as string | null) ?? null,
          { gracePeriodEndsText: formatFriendlyDate(gracePeriodEnd) },
        )
      }
      break
    }

    case 'invoice.paid': {
      // Payment succeeded — clear grace window. Never override 'trialing'
      // because some providers fire invoice.paid for $0 trial invoices.
      if (!result.workspaceId) break
      const account = await db.getActivePaymentAccount(result.workspaceId)
      if (!account) break
      const currentStatus = account.subscription_status as string | null | undefined
      if (currentStatus === 'trialing') break

      const customerId = account.customer_id as string
      const provider = account.provider as string
      const nextStatus = currentStatus === 'past_due' ? 'active' : currentStatus ?? null

      await db.upsertPaymentAccount({
        workspaceId: result.workspaceId,
        provider,
        customerId,
        subscriptionId: (account.subscription_id as string | null) ?? null,
        subscriptionStatus: nextStatus,
        currentPeriodEnd: (account.current_period_end as string | null) ?? null,
        trialEndsAt: null,
        cancelAtPeriodEnd: Boolean(account.cancel_at_period_end),
        gracePeriodEndsAt: null,
        plan: (account.plan as string | null) ?? null,
        isActive: true,
      })
      // Only email on recovery from past_due — regular monthly renewals
      // shouldn't trigger a "payment received" email.
      if (currentStatus === 'past_due') {
        await sendBillingEmail(
          result.workspaceId,
          'payment-recovered',
          (account.plan as string | null) ?? null,
        )
      }
      break
    }

    case 'noop':
      break
  }

  return { received: true }
})
