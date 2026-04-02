/**
 * Stripe PaymentProvider implementation.
 *
 * Handles checkout sessions, customer portal, and webhook events.
 * Requires NUXT_STRIPE_SECRET_KEY and NUXT_STRIPE_WEBHOOK_SECRET.
 *
 * Trial: 14-day Stripe trial (trial_period_days=14 on subscription).
 * No credit card is NOT collected before trial — CC is required at checkout.
 */

import Stripe from 'stripe'
import type { CheckoutInput, CheckoutResult, PaymentProvider, PortalInput, PortalResult, WebhookResult } from './payment'

// Stripe price IDs — set in Stripe Dashboard, referenced here
const PLAN_PRICE_MAP: Record<string, string> = {
  starter: process.env.NUXT_STRIPE_STARTER_PRICE_ID ?? '',
  pro: process.env.NUXT_STRIPE_PRO_PRICE_ID ?? '',
}

/** Reverse lookup: price ID → plan name. Used to derive plan from Stripe Portal changes. */
function planFromPriceId(priceId: string | undefined): string | undefined {
  if (!priceId) return undefined
  for (const [plan, id] of Object.entries(PLAN_PRICE_MAP)) {
    if (id === priceId) return plan
  }
  return undefined
}

/** Extract the plan from a Stripe Subscription by checking items' price IDs first, metadata second. */
function resolvePlanFromSubscription(subscription: Stripe.Subscription): string | undefined {
  // 1. Price-based lookup (authoritative — works after Portal plan changes)
  const priceId = subscription.items?.data?.[0]?.price?.id
  const fromPrice = planFromPriceId(priceId)
  if (fromPrice) return fromPrice
  // 2. Metadata fallback (set at checkout, may be stale after Portal changes)
  return subscription.metadata?.plan
}

/** Trial duration in days — matches Stripe subscription trial. */
const TRIAL_PERIOD_DAYS = 14

export function createStripePaymentProvider(): PaymentProvider {
  const config = useRuntimeConfig()
  const secretKey = config.stripe?.secretKey as string

  if (!secretKey) {
    throw new Error('NUXT_STRIPE_SECRET_KEY is required for Stripe payment provider')
  }

  const stripe = new Stripe(secretKey)
  const webhookSecret = config.stripe?.webhookSecret as string

  return {
    async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
      const priceId = PLAN_PRICE_MAP[input.plan]
      if (!priceId) {
        throw new Error(`No Stripe price ID configured for plan: ${input.plan}`)
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        client_reference_id: input.workspaceId,
        customer_email: input.customerEmail,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          workspace_id: input.workspaceId,
          plan: input.plan,
        },
        subscription_data: {
          trial_period_days: TRIAL_PERIOD_DAYS,
          metadata: {
            workspace_id: input.workspaceId,
            plan: input.plan,
          },
        },
      })

      return {
        url: session.url!,
        sessionId: session.id,
      }
    },

    async createPortalSession(input: PortalInput): Promise<PortalResult> {
      const session = await stripe.billingPortal.sessions.create({
        customer: input.stripeCustomerId,
        return_url: input.returnUrl,
      })

      return { url: session.url }
    },

    async handleWebhook(payload: string, signature: string): Promise<WebhookResult> {
      if (!webhookSecret) {
        throw new Error('NUXT_STRIPE_WEBHOOK_SECRET is required')
      }

      const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret)

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session
          const subscription = session.subscription
            ? await stripe.subscriptions.retrieve(session.subscription as string)
            : null

          // current_period_end lives on subscription items in Stripe SDK v21+
          const checkoutItemPeriodEnd = subscription?.items?.data?.[0]?.current_period_end
          return {
            event: event.type,
            workspaceId: session.metadata?.workspace_id,
            plan: session.metadata?.plan,
            subscriptionId: session.subscription as string,
            customerId: session.customer as string,
            subscriptionStatus: subscription?.status,
            currentPeriodEnd: checkoutItemPeriodEnd
              ? new Date(checkoutItemPeriodEnd * 1000).toISOString()
              : undefined,
            cancelAtPeriodEnd: subscription?.cancel_at_period_end,
          }
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription
          // current_period_end lives on subscription items in Stripe SDK v21+
          const itemPeriodEnd = subscription.items?.data?.[0]?.current_period_end
          // Derive plan from price ID (handles Portal-driven plan changes)
          const resolvedPlan = resolvePlanFromSubscription(subscription)
          return {
            event: event.type,
            workspaceId: subscription.metadata?.workspace_id,
            plan: resolvedPlan,
            subscriptionId: subscription.id,
            customerId: subscription.customer as string,
            subscriptionStatus: subscription.status,
            currentPeriodEnd: itemPeriodEnd
              ? new Date(itemPeriodEnd * 1000).toISOString()
              : undefined,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          }
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription
          return {
            event: event.type,
            workspaceId: subscription.metadata?.workspace_id,
            subscriptionId: subscription.id,
            customerId: subscription.customer as string,
            subscriptionStatus: 'canceled',
          }
        }

        case 'invoice.payment_failed':
        case 'invoice.paid': {
          // Invoice webhook payloads have a looser shape than the typed SDK.
          // Use a raw record to safely extract the fields we need.
          const raw = event.data.object as unknown as Record<string, unknown>
          const subField = raw.subscription
          const subId = typeof subField === 'string' ? subField : (subField as { id?: string })?.id
          const custField = raw.customer
          const custId = typeof custField === 'string' ? custField : (custField as { id?: string })?.id
          const subDetails = raw.subscription_details as { metadata?: Record<string, string> } | null
          return {
            event: event.type,
            workspaceId: subDetails?.metadata?.workspace_id,
            subscriptionId: subId,
            customerId: custId,
            invoiceId: raw.id as string,
          }
        }

        default:
          return { event: event.type }
      }
    },

    async cancelSubscription(subscriptionId: string): Promise<void> {
      await stripe.subscriptions.cancel(subscriptionId)
    },
  }
}
