/**
 * Stripe PaymentProvider implementation.
 *
 * Handles checkout sessions, customer portal, and webhook events.
 * Requires NUXT_STRIPE_SECRET_KEY and NUXT_STRIPE_WEBHOOK_SECRET.
 */

import Stripe from 'stripe'
import type { CheckoutInput, CheckoutResult, PaymentProvider, PortalInput, PortalResult, WebhookResult } from './payment'

// Stripe price IDs — set in Stripe Dashboard, referenced here
// These should be moved to runtime config when multiple environments exist
const PLAN_PRICE_MAP: Record<string, string> = {
  starter: process.env.NUXT_STRIPE_STARTER_PRICE_ID ?? '',
  pro: process.env.NUXT_STRIPE_PRO_PRICE_ID ?? '',
}

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
        customer_email: input.customerEmail,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          workspace_id: input.workspaceId,
          plan: input.plan,
        },
        subscription_data: {
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
          return {
            event: event.type,
            workspaceId: session.metadata?.workspace_id,
            plan: session.metadata?.plan,
            subscriptionId: session.subscription as string,
            customerId: session.customer as string,
          }
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription
          return {
            event: event.type,
            workspaceId: subscription.metadata?.workspace_id,
            plan: subscription.metadata?.plan,
            subscriptionId: subscription.id,
            customerId: subscription.customer as string,
          }
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription
          return {
            event: event.type,
            workspaceId: subscription.metadata?.workspace_id,
            subscriptionId: subscription.id,
            customerId: subscription.customer as string,
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
