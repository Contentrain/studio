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
import { BILLABLE_METERS_KEY, reconcileOverageLock } from '../../../utils/overage-lock'
import type { OverageLockAccount } from '../../../utils/overage-lock'

type Db = ReturnType<typeof useDatabaseProvider>

/**
 * Line the workspace's overage toggles up with what the subscription can
 * bill (`server/utils/overage-lock.ts`): a toggle the subscription cannot
 * invoice is turned off and remembered, and turned back on by the event
 * that lifts the lock — trial end, or the subscription moving to current
 * prices. Returns the `plugin_metadata` to store with the upsert
 * (undefined = keep the stored value) and a `commit` that writes the
 * toggles once the account row is in place.
 *
 * Public routes (forms, MCP Cloud, comments, media API) read
 * `overage_settings` straight from the workspace row, so the lock is
 * written there, not only applied where the billing middleware runs.
 */
async function planOverageLock(db: Db, input: {
  workspaceId: string
  billableMeters?: string[]
  storedPluginMetadata: unknown
  account: Omit<OverageLockAccount, 'plugin_metadata'>
}): Promise<{ pluginMetadata: Record<string, unknown> | undefined, commit: () => Promise<void> }> {
  let settings: Record<string, boolean> | null = null
  try {
    const workspace = await db.getWorkspaceById(input.workspaceId, 'id, overage_settings')
    settings = (workspace?.overage_settings as Record<string, boolean> | null) ?? {}
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[billing] overage settings unreadable for ${input.workspaceId}:`, err)
  }
  if (settings === null) {
    // Toggles unreadable: record the prices, leave toggles and the
    // suspended list alone. The billing middleware still applies the lock
    // to the chat and media routes at read time.
    const stored = (input.storedPluginMetadata as Record<string, unknown> | null) ?? {}
    return {
      pluginMetadata: input.billableMeters ? { ...stored, [BILLABLE_METERS_KEY]: input.billableMeters } : undefined,
      commit: async () => {},
    }
  }
  const plan = reconcileOverageLock({
    settings,
    pluginMetadata: input.storedPluginMetadata,
    billableMeters: input.billableMeters,
    account: input.account,
  })
  return {
    pluginMetadata: plan.pluginMetadata,
    commit: async () => {
      if (plan.settings)
        await db.updateWorkspace('', input.workspaceId, { overage_settings: plan.settings })
    },
  }
}

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

/**
 * How long a workspace keeps working after a payment fails. Past it the
 * workspace is locked (`grace_expired`) until the card is fixed; the
 * provider keeps retrying meanwhile (Polar: days 2, 7, 14, 21, then it
 * ends the subscription), and a later successful charge unlocks it.
 */
const PAYMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** The grace window already running, or a fresh one from now. */
function graceEndFrom(existing: string | null | undefined): string {
  return existing ?? new Date(Date.now() + PAYMENT_GRACE_MS).toISOString()
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
      const overageLock = await planOverageLock(db, {
        workspaceId: result.workspaceId,
        billableMeters: result.billableMeters,
        storedPluginMetadata: null,
        account: {
          subscription_status: result.subscriptionStatus ?? 'trialing',
          trial_ends_at: result.trialEndsAt ?? null,
          current_period_end: result.currentPeriodEnd ?? null,
        },
      })
      await db.upsertPaymentAccount({
        workspaceId: result.workspaceId,
        provider: plugin.key,
        customerId: result.customerId,
        subscriptionId: result.subscriptionId ?? null,
        subscriptionStatus: result.subscriptionStatus ?? 'trialing',
        currentPeriodStart: result.currentPeriodStart ?? null,
        currentPeriodEnd: result.currentPeriodEnd ?? null,
        // Only the provider's real trial_end — never the billing period end.
        trialEndsAt: result.trialEndsAt ?? null,
        cancelAtPeriodEnd: result.cancelAtPeriodEnd ?? false,
        gracePeriodEndsAt: null,
        plan: result.plan ?? null,
        pluginMetadata: overageLock.pluginMetadata,
        isActive: true,
      })
      await overageLock.commit()
      // A subscription started from a Migrate grant's checkout uses the
      // grant up: no second included trial after cancel-and-resubscribe.
      // Idempotent — whichever of created/updated arrives first marks it.
      if (result.migrateGrantId) {
        await db.markMigrateGrantRedeemed(result.migrateGrantId, result.subscriptionId ?? null)
      }
      // First 'trialing' observation consumes the workspace's one-time
      // trial, so a later re-checkout (after cancel/expiry) gets a paid
      // checkout with no new trial. Idempotent (set once, never moved).
      if ((result.subscriptionStatus ?? 'trialing') === 'trialing') {
        await db.markWorkspaceTrialConsumed(result.workspaceId)
      }
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
      // transitions worth emailing on (trial→active, payment failed or
      // recovered, cancellation scheduled).
      const existingAccount = await db.getActivePaymentAccount(result.workspaceId)
      // A late update about a subscription the workspace has since replaced
      // must not overwrite the new one's state (same rule as the ending
      // branch below).
      const activeSubscriptionId = (existingAccount?.subscription_id as string | null | undefined) ?? null
      if (activeSubscriptionId && result.subscriptionId && activeSubscriptionId !== result.subscriptionId) break
      const wasTrialing = (existingAccount?.subscription_status as string | undefined) === 'trialing'
      const wasPastDue = (existingAccount?.subscription_status as string | undefined) === 'past_due'
      const becameActive = result.subscriptionStatus === 'active'
      // A failed renewal reaches us as an update with status `past_due`
      // (Polar sends no separate payment-failed event). The first one opens
      // the grace window; later ones — retries, card updates — keep it.
      const isPastDue = result.subscriptionStatus === 'past_due'
      const existingGrace = (existingAccount?.grace_period_ends_at as string | null | undefined) ?? null
      const gracePeriodEnd = isPastDue ? graceEndFrom(existingGrace) : null
      // A cancellation newly scheduled for the period (or trial) end. The
      // plan stays until then; the owner is told the date.
      const cancelScheduled = Boolean(result.cancelAtPeriodEnd) && !existingAccount?.cancel_at_period_end
      // Catch the trial here too, in case the first observation arrives as
      // an update rather than a create. Idempotent.
      if (result.subscriptionStatus === 'trialing') {
        await db.markWorkspaceTrialConsumed(result.workspaceId)
      }
      const overageLock = await planOverageLock(db, {
        workspaceId: result.workspaceId,
        billableMeters: result.billableMeters,
        storedPluginMetadata: existingAccount?.plugin_metadata ?? null,
        account: {
          subscription_status: result.subscriptionStatus ?? null,
          trial_ends_at: result.trialEndsAt ?? (existingAccount?.trial_ends_at as string | null) ?? null,
          current_period_end: result.currentPeriodEnd ?? null,
        },
      })
      await db.upsertPaymentAccount({
        workspaceId: result.workspaceId,
        provider: plugin.key,
        customerId: result.customerId,
        subscriptionId: result.subscriptionId ?? null,
        subscriptionStatus: result.subscriptionStatus ?? null,
        currentPeriodStart: result.currentPeriodStart ?? null,
        currentPeriodEnd: result.currentPeriodEnd ?? null,
        // Clear trial_ends_at when transitioning to active. While still
        // trialing (e.g. a portal plan change mid-trial), keep the real
        // trial_end — preserve the existing value when the provider omits it
        // on the update, and never fall back to the billing period end (which
        // is a cycle boundary, not the trial expiry).
        trialEndsAt: result.subscriptionStatus === 'trialing'
          ? result.trialEndsAt ?? (existingAccount?.trial_ends_at as string | null) ?? null
          : null,
        cancelAtPeriodEnd: result.cancelAtPeriodEnd ?? false,
        gracePeriodEndsAt: gracePeriodEnd,
        plan: result.plan ?? null,
        pluginMetadata: overageLock.pluginMetadata,
        isActive: true,
      })
      await overageLock.commit()
      // A subscription started from a Migrate grant's checkout uses the
      // grant up: no second included trial after cancel-and-resubscribe.
      // Idempotent — whichever of created/updated arrives first marks it.
      if (result.migrateGrantId) {
        await db.markMigrateGrantRedeemed(result.migrateGrantId, result.subscriptionId ?? null)
      }

      const workspaceUpdate: Record<string, unknown> = {}
      if (result.plan) workspaceUpdate.plan = result.plan
      // Reset reminder stage when trial→active so a future trial restarts the sequence.
      if (becameActive) workspaceUpdate.trial_reminder_stage = 0
      if (Object.keys(workspaceUpdate).length > 0) {
        await db.updateWorkspace('', result.workspaceId, workspaceUpdate)
      }
      // Only state transitions email. Plan swaps, quantity changes, card
      // updates all flow through subscription.updated too and would spam
      // the owner otherwise.
      if (becameActive && wasTrialing) {
        await sendBillingEmail(result.workspaceId, 'subscription-activated', result.plan)
      }
      // Payment problems are never silent: the owner hears when the grace
      // window opens (and until when), and again when the charge goes
      // through. `invoice.paid` may get to the recovery first; whichever
      // sees `past_due` flip to active sends it, the other finds it active.
      if (isPastDue && !existingGrace && gracePeriodEnd) {
        await sendBillingEmail(result.workspaceId, 'payment-failed', result.plan, {
          gracePeriodEndsText: formatFriendlyDate(gracePeriodEnd),
        })
      }
      if (becameActive && wasPastDue) {
        await sendBillingEmail(result.workspaceId, 'payment-recovered', result.plan)
      }
      if (cancelScheduled) {
        const accessEndsAt = result.accessEndsAt
          ?? (result.subscriptionStatus === 'trialing' ? result.trialEndsAt : result.currentPeriodEnd)
        if (accessEndsAt) {
          await sendBillingEmail(result.workspaceId, 'subscription-cancel-scheduled', result.plan, {
            accessEndsText: formatFriendlyDate(accessEndsAt),
          })
        }
      }
      break
    }

    case 'subscription.canceled': {
      // The subscription has ended (the provider plugin sends a cancellation
      // scheduled for the period end as `subscription.updated`).
      if (!result.workspaceId) break
      // Snapshot the plan BEFORE archive + downgrade so the email
      // reflects what was canceled, not the post-cancel "free" state.
      const priorAccount = await db.getActivePaymentAccount(result.workspaceId)
      // A late event about a subscription the workspace has since replaced
      // must not end the new one.
      const activeSubscriptionId = (priorAccount?.subscription_id as string | null | undefined) ?? null
      if (activeSubscriptionId && result.subscriptionId && activeSubscriptionId !== result.subscriptionId) break
      const canceledPlan = result.plan ?? (priorAccount?.plan as string | null)
      await db.archiveActivePaymentAccount(result.workspaceId)
      await db.updateWorkspace('', result.workspaceId, {
        plan: 'free',
        trial_reminder_stage: 0,
      })
      // One ending arrives as several events (Polar: updated, canceled,
      // revoked — all `canceled`). Only the one that found the account
      // still active tells the owner.
      if (priorAccount) {
        await sendBillingEmail(result.workspaceId, 'subscription-canceled', canceledPlan)
      }
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
      const gracePeriodEnd = graceEndFrom(existingGrace)

      await db.upsertPaymentAccount({
        workspaceId: result.workspaceId,
        provider,
        customerId,
        subscriptionId: (account.subscription_id as string | null) ?? null,
        subscriptionStatus: 'past_due',
        currentPeriodStart: (account.current_period_start as string | null) ?? null,
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
        currentPeriodStart: (account.current_period_start as string | null) ?? null,
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
