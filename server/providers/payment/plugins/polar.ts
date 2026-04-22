/**
 * Polar payment plugin.
 *
 * Implements `PaymentProvider` against the Polar SDK. Active when
 * `NUXT_POLAR_ACCESS_TOKEN` is set.
 *
 * Design notes:
 * - `externalCustomerId` is always set to the workspace ID so Polar's
 *   customer lookups line up with Studio's workspace lifecycle, and
 *   usage events can be ingested without a prior customer fetch.
 * - Polar's webhook signature is Standard Webhooks (`webhook-*`
 *   headers); the SDK's `validateEvent` handles the HMAC + timestamp
 *   tolerance. We just normalise the resulting typed event to the
 *   provider-agnostic `WebhookResult` shape.
 * - Trial: Polar collects the payment method at checkout and honours
 *   the product's trial configuration unless `allowTrial: false`.
 */

import { Polar } from '@polar-sh/sdk'
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks'
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

interface PolarConfig {
  accessToken?: string
  webhookSecret?: string
  starterProductId?: string
  proProductId?: string
  /** 'sandbox' | 'production' — Polar SDK server mode. Defaults to 'production'. */
  server?: string
}

function readPolarConfig(config: PaymentPluginConfig): PolarConfig {
  return (config.polar as PolarConfig | undefined) ?? {}
}

function buildProductMap(cfg: PolarConfig): Record<string, string> {
  return {
    starter: cfg.starterProductId ?? '',
    pro: cfg.proProductId ?? '',
  }
}

function planFromProductId(productId: string | undefined, productMap: Record<string, string>): string | undefined {
  if (!productId) return undefined
  for (const [plan, id] of Object.entries(productMap)) {
    if (id === productId) return plan
  }
  return undefined
}

function isoOrUndefined(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString()
  return value
}

/**
 * Minimal shape of a Polar Subscription payload used by our webhook mapping.
 * Keeps the adapter loosely-coupled to the SDK type (which is large and
 * version-sensitive) — we only touch the fields we care about.
 */
interface PolarSubscriptionLike {
  id: string
  status: string
  customerId: string
  productId: string
  currentPeriodEnd: Date | string | null
  trialEnd: Date | string | null
  cancelAtPeriodEnd: boolean
  metadata?: Record<string, unknown>
}

function subscriptionToResult(
  canonicalEvent: CanonicalWebhookEvent,
  sub: PolarSubscriptionLike,
  productMap: Record<string, string>,
): WebhookResult {
  const workspaceId = typeof sub.metadata?.workspace_id === 'string' ? sub.metadata.workspace_id : undefined
  const planFromMeta = typeof sub.metadata?.plan === 'string' ? sub.metadata.plan : undefined

  return {
    event: canonicalEvent,
    workspaceId,
    plan: planFromProductId(sub.productId, productMap) ?? planFromMeta,
    subscriptionId: sub.id,
    customerId: sub.customerId,
    subscriptionStatus: sub.status,
    currentPeriodEnd: isoOrUndefined(sub.currentPeriodEnd),
    trialEndsAt: sub.status === 'trialing' ? isoOrUndefined(sub.trialEnd) : undefined,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
  }
}

function createPolarProvider(config: PaymentPluginConfig): PaymentProvider {
  const cfg = readPolarConfig(config)
  const accessToken = cfg.accessToken
  if (!accessToken) {
    throw new Error('NUXT_POLAR_ACCESS_TOKEN is required for Polar payment provider')
  }

  const server = (cfg.server === 'sandbox' ? 'sandbox' : 'production') as 'sandbox' | 'production'
  const polar = new Polar({ accessToken, server })
  const webhookSecret = cfg.webhookSecret ?? ''
  const productMap = buildProductMap(cfg)

  return {
    async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
      const productId = productMap[input.plan]
      if (!productId) {
        throw new Error(`No Polar product ID configured for plan: ${input.plan}`)
      }

      const checkout = await polar.checkouts.create({
        products: [productId],
        customerEmail: input.customerEmail,
        externalCustomerId: input.workspaceId,
        successUrl: input.successUrl,
        metadata: {
          workspace_id: input.workspaceId,
          plan: input.plan,
        },
        customerMetadata: {
          workspace_id: input.workspaceId,
        },
      })

      return {
        url: checkout.url,
        sessionId: checkout.id,
      }
    },

    async createPortalSession(input: PortalInput): Promise<PortalResult> {
      const session = await polar.customerSessions.create({
        customerId: input.customerId,
      })

      return { url: session.customerPortalUrl }
    },

    async handleWebhook(payload, headers): Promise<WebhookResult> {
      if (!webhookSecret) {
        throw new Error('NUXT_POLAR_WEBHOOK_SECRET is required')
      }

      // Standard Webhooks expects `webhook-id` / `webhook-timestamp` /
      // `webhook-signature` headers. `validateEvent` handles verification
      // and returns a typed payload, or throws `WebhookVerificationError`.
      const normalisedHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string') normalisedHeaders[key] = value
      }

      let event
      try {
        event = validateEvent(payload, normalisedHeaders, webhookSecret)
      }
      catch (err) {
        if (err instanceof WebhookVerificationError) {
          throw new Error('Webhook signature verification failed')
        }
        throw err
      }

      switch (event.type) {
        case 'subscription.created':
          return subscriptionToResult('subscription.created', event.data as unknown as PolarSubscriptionLike, productMap)

        case 'subscription.updated':
        case 'subscription.active':
        case 'subscription.uncanceled':
          return subscriptionToResult('subscription.updated', event.data as unknown as PolarSubscriptionLike, productMap)

        case 'subscription.past_due':
          return {
            ...subscriptionToResult('subscription.updated', event.data as unknown as PolarSubscriptionLike, productMap),
            subscriptionStatus: 'past_due',
          }

        case 'subscription.canceled':
        case 'subscription.revoked': {
          const sub = event.data as unknown as PolarSubscriptionLike
          return {
            event: 'subscription.canceled',
            workspaceId: typeof sub.metadata?.workspace_id === 'string' ? sub.metadata.workspace_id : undefined,
            subscriptionId: sub.id,
            customerId: sub.customerId,
            subscriptionStatus: 'canceled',
          }
        }

        case 'order.paid': {
          const order = event.data as unknown as {
            id: string
            customerId: string
            subscriptionId: string | null
            metadata?: Record<string, unknown>
          }
          const workspaceId = typeof order.metadata?.workspace_id === 'string' ? order.metadata.workspace_id : undefined
          return {
            event: 'invoice.paid',
            workspaceId,
            subscriptionId: order.subscriptionId ?? undefined,
            customerId: order.customerId,
            invoiceId: order.id,
          }
        }

        default:
          return { event: 'noop' }
      }
    },

    async cancelSubscription(subscriptionId: string): Promise<void> {
      await polar.subscriptions.revoke({ id: subscriptionId })
    },

    async ingestUsageEvent(input: UsageEventInput): Promise<void> {
      await polar.events.ingest({
        events: [{
          name: input.meterName,
          externalCustomerId: input.workspaceId,
          timestamp: input.occurredAt ? new Date(input.occurredAt) : undefined,
          metadata: {
            ...(input.metadata ?? {}),
            value: input.value,
            idempotency_key: input.idempotencyKey,
          },
          externalId: input.idempotencyKey,
        }],
      })
    },
  }
}

export const polarPlugin: PaymentProviderPlugin = {
  key: 'polar',
  label: 'Polar',
  isConfigured(config: PaymentPluginConfig): boolean {
    return !!readPolarConfig(config).accessToken
  },
  create(config: PaymentPluginConfig): PaymentProvider {
    return createPolarProvider(config)
  },
}
