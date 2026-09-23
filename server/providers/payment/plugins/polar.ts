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
  currentPeriodStart: Date | string | null
  currentPeriodEnd: Date | string | null
  trialEnd: Date | string | null
  cancelAtPeriodEnd: boolean
  /** When a scheduled cancellation takes effect (set with `cancelAtPeriodEnd`). */
  endsAt?: Date | string | null
  /** When the subscription actually ended — only set once it has. */
  endedAt?: Date | string | null
  metadata?: Record<string, unknown>
  prices?: Array<{ amountType?: string, meter?: { name?: string } | null }>
}

/**
 * Meters the subscription itself prices. Polar keeps a subscription on the
 * prices it was created with, so a catalogue change does not reach it —
 * this is the list overage may be sold against.
 */
function billableMetersOf(sub: PolarSubscriptionLike): string[] | undefined {
  if (!Array.isArray(sub.prices)) return undefined
  const names = sub.prices
    .filter(p => p.amountType === 'metered_unit')
    .map(p => p.meter?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  return [...new Set(names)].toSorted()
}

/**
 * Whether the customer's access is over.
 *
 * Polar names events after what happened, not after where the
 * subscription stands: `subscription.canceled` fires when a cancellation
 * is *scheduled* (status still `active`, `cancelAtPeriodEnd`, `endsAt` =
 * period end), and again, with `subscription.revoked`, when it takes
 * effect (status `canceled`, `endedAt` set). Only the second ends a
 * paid period, so the payload decides, never the event name.
 */
function hasEnded(sub: PolarSubscriptionLike): boolean {
  return Boolean(sub.endedAt) || sub.status === 'canceled' || sub.status === 'incomplete_expired'
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
    currentPeriodStart: isoOrUndefined(sub.currentPeriodStart),
    currentPeriodEnd: isoOrUndefined(sub.currentPeriodEnd),
    trialEndsAt: sub.status === 'trialing' ? isoOrUndefined(sub.trialEnd) : undefined,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    billableMeters: billableMetersOf(sub),
    accessEndsAt: sub.cancelAtPeriodEnd ? isoOrUndefined(sub.endsAt) : undefined,
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
        // The product's trial config applies by default; `allowTrial: false`
        // suppresses it for a workspace that has already used its trial.
        ...(input.withTrial === false ? { allowTrial: false } : {}),
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
          throw new Error('Webhook signature verification failed', { cause: err })
        }
        throw err
      }

      switch (event.type) {
        case 'subscription.created':
          return subscriptionToResult('subscription.created', event.data as unknown as PolarSubscriptionLike, productMap)

        // Every subscription lifecycle event is mapped by the state it
        // carries (`hasEnded`): a cancellation scheduled for the period end
        // keeps the subscription — and the plan the customer paid for — until
        // Polar ends it, which it announces with a status of `canceled`.
        case 'subscription.updated':
        case 'subscription.active':
        case 'subscription.uncanceled':
        case 'subscription.past_due':
        case 'subscription.canceled':
        case 'subscription.revoked': {
          const sub = event.data as unknown as PolarSubscriptionLike
          if (hasEnded(sub)) {
            return {
              event: 'subscription.canceled',
              workspaceId: typeof sub.metadata?.workspace_id === 'string' ? sub.metadata.workspace_id : undefined,
              subscriptionId: sub.id,
              customerId: sub.customerId,
              subscriptionStatus: 'canceled',
            }
          }
          const result = subscriptionToResult('subscription.updated', sub, productMap)
          return event.type === 'subscription.past_due' ? { ...result, subscriptionStatus: 'past_due' } : result
        }

        case 'order.paid': {
          const order = event.data as unknown as {
            id: string
            customerId: string
            subscriptionId: string | null
            totalAmount?: number
            metadata?: Record<string, unknown>
            subscription?: { metadata?: Record<string, unknown> } | null
            customer?: { externalId?: string | null } | null
          }
          // A renewal or trial-conversion order is created by Polar, not by
          // our checkout, so it may not carry the checkout metadata. The
          // subscription's metadata and the customer's external id (set to
          // the workspace id at checkout) name the workspace too.
          const fromMeta = (m?: Record<string, unknown>) => (typeof m?.workspace_id === 'string' ? m.workspace_id : undefined)
          const workspaceId = fromMeta(order.metadata)
            ?? fromMeta(order.subscription?.metadata)
            ?? order.customer?.externalId
            ?? undefined
          return {
            event: 'invoice.paid',
            workspaceId,
            subscriptionId: order.subscriptionId ?? undefined,
            customerId: order.customerId,
            invoiceId: order.id,
            ...(typeof order.totalAmount === 'number' ? { amountPaid: order.totalAmount } : {}),
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
