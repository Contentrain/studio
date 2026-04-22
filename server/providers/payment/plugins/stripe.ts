/**
 * Stripe payment plugin.
 *
 * Implements the `PaymentProvider` interface against the Stripe SDK.
 * Active when `NUXT_STRIPE_SECRET_KEY` is set. Trial is collected at
 * checkout (`trial_period_days=14`); a credit card is always required.
 *
 * Note — Stripe does not support real-time meter ingestion the way Polar
 * does. `ingestUsageEvent` is a no-op here and logs a warning; new
 * deployments should use the Polar plugin for overage billing.
 */

import Stripe from 'stripe'
import type {
  CanonicalWebhookEvent,
  CheckoutInput,
  CheckoutResult,
  PaymentPluginConfig,
  PaymentProvider,
  PaymentProviderPlugin,
  PortalInput,
  PortalResult,
  UsageEventInput,
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

function secondsToIso(seconds: number | null | undefined): string | undefined {
  if (!seconds) return undefined
  return new Date(seconds * 1000).toISOString()
}

function mapSubscriptionToResult(
  event: CanonicalWebhookEvent,
  subscription: Stripe.Subscription,
  priceMap: Record<string, string>,
): WebhookResult {
  const itemPeriodEnd = subscription.items?.data?.[0]?.current_period_end
  return {
    event,
    workspaceId: subscription.metadata?.workspace_id,
    plan: resolvePlanFromSubscription(subscription, priceMap),
    subscriptionId: subscription.id,
    customerId: subscription.customer as string,
    subscriptionStatus: subscription.status,
    currentPeriodEnd: secondsToIso(itemPeriodEnd),
    trialEndsAt: subscription.status === 'trialing'
      ? secondsToIso(subscription.trial_end) ?? secondsToIso(itemPeriodEnd)
      : undefined,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  }
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

    async handleWebhook(payload, headers): Promise<WebhookResult> {
      if (!webhookSecret) {
        throw new Error('NUXT_STRIPE_WEBHOOK_SECRET is required')
      }

      const signature = headers['stripe-signature']
      if (!signature) {
        throw new Error('Missing stripe-signature header')
      }

      const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret)

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session
          const subscription = session.subscription
            ? await stripe.subscriptions.retrieve(session.subscription as string)
            : null

          if (!subscription) {
            return { event: 'subscription.created', workspaceId: session.metadata?.workspace_id }
          }

          return {
            ...mapSubscriptionToResult('subscription.created', subscription, priceMap),
            // Prefer checkout metadata for plan — Stripe may not return price yet
            plan: session.metadata?.plan ?? resolvePlanFromSubscription(subscription, priceMap),
            workspaceId: session.metadata?.workspace_id ?? subscription.metadata?.workspace_id,
          }
        }

        case 'customer.subscription.updated': {
          return mapSubscriptionToResult('subscription.updated', event.data.object as Stripe.Subscription, priceMap)
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription
          return {
            event: 'subscription.canceled',
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
            event: event.type === 'invoice.paid' ? 'invoice.paid' : 'invoice.payment_failed',
            workspaceId: subDetails?.metadata?.workspace_id,
            subscriptionId: subId,
            customerId: custId,
            invoiceId: raw.id as string,
          }
        }

        default:
          return { event: 'noop' }
      }
    },

    async cancelSubscription(subscriptionId: string): Promise<void> {
      await stripe.subscriptions.cancel(subscriptionId)
    },

    async ingestUsageEvent(_input: UsageEventInput): Promise<void> {
      // Stripe does not support real-time meter ingestion; overage billing
      // under Stripe is not supported in this version. Silently drop so
      // the outbox drain proceeds without piling up errors.
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
