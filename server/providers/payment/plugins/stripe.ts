/**
 * Stripe payment plugin.
 *
 * Implements the `PaymentProvider` interface against the Stripe SDK.
 * Active when `NUXT_STRIPE_SECRET_KEY` is set. Trial is collected at
 * checkout (`trial_period_days=14`); a credit card is always required.
 */

import Stripe from 'stripe'
import type {
  CheckoutInput,
  CheckoutResult,
  InvoiceItemInput,
  PaymentPluginConfig,
  PaymentProvider,
  PaymentProviderPlugin,
  PortalInput,
  PortalResult,
  WebhookResult,
} from '../types'

interface StripeConfig {
  secretKey?: string
  webhookSecret?: string
  starterPriceId?: string
  proPriceId?: string
}

function readStripeConfig(config: PaymentPluginConfig): StripeConfig {
  return (config.stripe as StripeConfig | undefined) ?? {}
}

const TRIAL_PERIOD_DAYS = 14

function buildPriceMap(cfg: StripeConfig): Record<string, string> {
  return {
    starter: cfg.starterPriceId ?? '',
    pro: cfg.proPriceId ?? '',
  }
}

/** Reverse lookup: price ID → plan name. Handles Portal-driven plan changes. */
function planFromPriceId(priceId: string | undefined, priceMap: Record<string, string>): string | undefined {
  if (!priceId) return undefined
  for (const [plan, id] of Object.entries(priceMap)) {
    if (id === priceId) return plan
  }
  return undefined
}

function resolvePlanFromSubscription(
  subscription: Stripe.Subscription,
  priceMap: Record<string, string>,
): string | undefined {
  const priceId = subscription.items?.data?.[0]?.price?.id
  const fromPrice = planFromPriceId(priceId, priceMap)
  if (fromPrice) return fromPrice
  return subscription.metadata?.plan
}

function createStripeProvider(config: PaymentPluginConfig): PaymentProvider {
  const cfg = readStripeConfig(config)
  const secretKey = cfg.secretKey
  if (!secretKey) {
    throw new Error('NUXT_STRIPE_SECRET_KEY is required for Stripe payment provider')
  }

  const stripe = new Stripe(secretKey)
  const webhookSecret = cfg.webhookSecret ?? ''
  const priceMap = buildPriceMap(cfg)

  return {
    async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
      const priceId = priceMap[input.plan]
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
        customer: input.customerId,
        return_url: input.returnUrl,
      })

      return { url: session.url }
    },

    async handleWebhook(payload: string, signature: string): Promise<WebhookResult> {
      if (!webhookSecret) {
        throw new Error('NUXT_STRIPE_WEBHOOK_SECRET is required')
      }

      const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret)

      // invoice.creating is a valid Stripe webhook event but is not in the SDK's
      // discriminated event union. Handle it before the typed switch.
      const eventType: string = event.type
      if (eventType === 'invoice.creating') {
        const raw = (event as unknown as { data: { object: Record<string, unknown> } }).data.object
        const subField = raw.subscription
        const subId = typeof subField === 'string' ? subField : (subField as { id?: string })?.id
        const custField = raw.customer
        const custId = typeof custField === 'string' ? custField : (custField as { id?: string })?.id
        const subDetails = raw.subscription_details as { metadata?: Record<string, string> } | null
        return {
          event: eventType,
          workspaceId: subDetails?.metadata?.workspace_id,
          subscriptionId: subId,
          customerId: custId,
          requiresOverageCalculation: true,
        }
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session
          const subscription = session.subscription
            ? await stripe.subscriptions.retrieve(session.subscription as string)
            : null

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
          const itemPeriodEnd = subscription.items?.data?.[0]?.current_period_end
          const resolvedPlan = resolvePlanFromSubscription(subscription, priceMap)
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

    async addInvoiceItem(input: InvoiceItemInput): Promise<{ invoiceItemId: string }> {
      const item = await stripe.invoiceItems.create({
        customer: input.customerId,
        subscription: input.subscriptionId,
        description: input.description,
        amount: input.amount,
        currency: input.currency ?? 'usd',
        metadata: input.metadata,
      })
      return { invoiceItemId: item.id }
    },
  }
}

export const stripePlugin: PaymentProviderPlugin = {
  key: 'stripe',
  label: 'Stripe',
  isConfigured(config: PaymentPluginConfig): boolean {
    return !!readStripeConfig(config).secretKey
  },
  create(config: PaymentPluginConfig): PaymentProvider {
    return createStripeProvider(config)
  },
}
