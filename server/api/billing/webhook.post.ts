/**
 * POST /api/billing/webhook
 *
 * Stripe webhook handler.
 * Processes subscription events and updates workspace plan accordingly.
 *
 * This route is public (no auth middleware) — Stripe sends webhooks directly.
 * Security is via Stripe signature verification.
 */
export default defineEventHandler(async (event) => {
  const body = await readRawBody(event)
  const signature = getRequestHeader(event, 'stripe-signature')

  if (!body || !signature) {
    throw createError({ statusCode: 400, message: 'Missing webhook payload or signature.' })
  }

  const { createStripePaymentProvider } = await import('../../providers/stripe-payment')
  const payment = createStripePaymentProvider()

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
        // Activate the subscription — update plan, clear trial, store Stripe IDs
        await db.updateWorkspace(
          '', // Admin operation — use service role
          result.workspaceId,
          {
            plan: result.plan,
            trial_ends_at: null,
            stripe_customer_id: result.customerId,
            stripe_subscription_id: result.subscriptionId,
          },
        )
      }
      break
    }

    case 'customer.subscription.deleted': {
      if (result.workspaceId) {
        // Subscription cancelled — downgrade to starter
        await db.updateWorkspace(
          '',
          result.workspaceId,
          {
            plan: 'starter',
            stripe_subscription_id: null,
          },
        )
      }
      break
    }
  }

  // Always return 200 to acknowledge receipt
  return { received: true }
})
