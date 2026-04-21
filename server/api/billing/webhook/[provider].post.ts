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

/** Extract every request header as a plain `{[key]: string | undefined}` object. */
function readAllHeaders(event: Parameters<typeof getRequestHeaders>[0]): Record<string, string | undefined> {
  const raw = getRequestHeaders(event)
  const result: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(raw)) {
    result[key.toLowerCase()] = value
  }
  return result
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
      break
    }

    case 'subscription.updated': {
      if (!result.workspaceId || !result.customerId) break
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
      break
    }

    case 'subscription.canceled': {
      if (!result.workspaceId) break
      await db.archiveActivePaymentAccount(result.workspaceId)
      await db.updateWorkspace('', result.workspaceId, {
        plan: 'free',
        trial_reminder_stage: 0,
      })
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
      break
    }

    case 'noop':
      break
  }

  return { received: true }
})
