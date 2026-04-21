/**
 * Payment provider interface + plugin contract.
 *
 * Core contract (`PaymentProvider`) is provider-agnostic: checkout, portal,
 * webhook, cancel. Concrete implementations live under `./plugins/`.
 *
 * Plugins self-register via `registry.ts`; the factory in
 * `server/utils/providers.ts` resolves the active plugin using
 * preference order + runtime config. Adding a new provider is one
 * new file + one `registerPlugin()` call — no core code changes.
 */

export interface CheckoutInput {
  workspaceId: string
  workspaceName: string
  plan: 'starter' | 'pro'
  customerEmail: string
  successUrl: string
  cancelUrl: string
}

export interface CheckoutResult {
  url: string
  sessionId: string
}

export interface PortalInput {
  workspaceId: string
  /** Provider-specific customer identifier (e.g. Stripe `cus_…`, Polar UUID). */
  customerId: string
  returnUrl: string
}

export interface PortalResult {
  url: string
}

/** Canonical webhook event names emitted to route handlers. Each plugin maps
 *  its native events to these values inside `handleWebhook`. */
export type CanonicalWebhookEvent
  = | 'subscription.created'
    | 'subscription.updated'
    | 'subscription.canceled'
    | 'invoice.paid'
    | 'invoice.payment_failed'
    | 'noop'

export interface WebhookResult {
  /** Canonical event name (see `CanonicalWebhookEvent`). */
  event: CanonicalWebhookEvent
  workspaceId?: string
  plan?: string
  subscriptionId?: string
  customerId?: string
  /** Provider-normalised status: trialing, active, past_due, canceled, unpaid, incomplete. */
  subscriptionStatus?: string
  /** ISO timestamp: when current billing period ends. */
  currentPeriodEnd?: string
  /** ISO timestamp: when trial ends (trialing subscriptions only). */
  trialEndsAt?: string
  /** Whether subscription will cancel at period end. */
  cancelAtPeriodEnd?: boolean
  /** Provider invoice/order ID (for payment events). */
  invoiceId?: string
}

export interface UsageEventInput {
  workspaceId: string
  /** Provider-specific customer identifier (e.g. Stripe `cus_…`, Polar UUID). */
  customerId: string
  /** Meter key — matches Polar meter slugs. See `shared/utils/usage-meters.ts`. */
  meterName: string
  value: number
  /** Idempotency key — prevents double-ingestion across retries. */
  idempotencyKey: string
  /** Event timestamp; defaults to now in the plugin if omitted. */
  occurredAt?: string
  metadata?: Record<string, string>
}

export interface PaymentProvider {
  /** Create a checkout session for plan subscription. */
  createCheckoutSession: (input: CheckoutInput) => Promise<CheckoutResult>

  /** Create a customer portal session for subscription management. */
  createPortalSession: (input: PortalInput) => Promise<PortalResult>

  /**
   * Verify and process a webhook event.
   *
   * `headers` carries the raw request headers. Each plugin picks the
   * signature/timestamp headers it needs (Stripe: `stripe-signature`;
   * Polar / Standard Webhooks: `webhook-signature` + `webhook-timestamp`
   * + `webhook-id`).
   */
  handleWebhook: (payload: string, headers: Record<string, string | undefined>) => Promise<WebhookResult>

  /** Cancel a subscription (immediate). */
  cancelSubscription: (subscriptionId: string) => Promise<void>

  /**
   * Record a usage event for metered/overage billing.
   *
   * Plugins map this to their native model — Polar ingests to a meter
   * via its events API; Stripe does not support real-time metering
   * and logs a warning (overage billing is no-op under Stripe).
   */
  ingestUsageEvent: (input: UsageEventInput) => Promise<void>
}

/**
 * Loose runtime config shape passed to plugins.
 *
 * Plugins read their own nested config (e.g. `config.stripe.secretKey`).
 * Keeping this loose avoids coupling the plugin contract to Nuxt's
 * `RuntimeConfig` type.
 */
export interface PaymentPluginConfig {
  [key: string]: unknown
}

/**
 * Plugin contract for a payment provider.
 *
 * Registering a plugin is how a new provider (Stripe, Polar, Paddle, …)
 * joins the runtime. `isConfigured()` decides whether the plugin can
 * be activated; `create()` produces the `PaymentProvider` instance.
 */
export interface PaymentProviderPlugin {
  /** Unique short identifier — also used as DB discriminator. */
  readonly key: string
  /** Human-readable label for UI/logs. */
  readonly label: string
  /** Whether this plugin has enough runtime config to be instantiated. */
  isConfigured: (config: PaymentPluginConfig) => boolean
  /** Construct the `PaymentProvider` instance. Only called when `isConfigured()` is true. */
  create: (config: PaymentPluginConfig) => PaymentProvider
}
