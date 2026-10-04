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
  /**
   * Whether to include the free trial. Defaults to `true` (omitted ⇒
   * trial on). The checkout route sets it to `false` for workspaces that
   * have already consumed their one-time trial so re-checkout is a paid
   * subscription with no new trial.
   */
  withTrial?: boolean
  /**
   * Trial length in days, overriding the product's own trial. Only a
   * server-verified entitlement sets it (a Migrate grant); never taken from
   * a client. Ignored when `withTrial` is false.
   */
  trialDays?: number
  /** Extra metadata copied onto the checkout and the subscription. */
  metadata?: Record<string, string>
}

export interface CheckoutResult {
  url: string
  sessionId: string
}

/**
 * A "Migrate with Studio" bundle checkout: one first invoice at a price Studio
 * computed (Migrate fee + Studio year 1), on a yearly subscription that moves
 * to the list product at the next period (`changeSubscriptionProduct`).
 */
export interface BundleCheckoutInput {
  workspaceId: string
  plan: 'starter' | 'pro'
  customerEmail: string
  /** The first invoice, in cents (USD). */
  amountCents: number
  successUrl: string
  /** Copied onto the checkout and the subscription (order, tenant, grant ids). */
  metadata: Record<string, string>
}

export interface BundleCheckoutResult extends CheckoutResult {
  /** When the checkout stops being payable (ISO). */
  expiresAt: string
  /** The list product the subscription must move to after it is created. */
  targetProductId: string
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
  /** The checkout that created the subscription (Polar `checkoutId`), when the provider reports it. */
  checkoutId?: string
  customerId?: string
  /** Provider-normalised status: trialing, active, past_due, canceled, unpaid, incomplete. */
  subscriptionStatus?: string
  /** ISO timestamp: when current billing period ends. */
  currentPeriodStart?: string
  currentPeriodEnd?: string
  /** ISO timestamp: when trial ends (trialing subscriptions only). */
  trialEndsAt?: string
  /** Whether subscription will cancel at period end. */
  cancelAtPeriodEnd?: boolean
  /**
   * When a scheduled cancellation takes effect — the end of what was paid
   * for (or of the trial). Set only while `cancelAtPeriodEnd` is true.
   */
  accessEndsAt?: string
  /**
   * The Migrate grant whose checkout created this subscription (checkout
   * metadata `migrate_grant_id`, copied to the subscription). Lets the
   * webhook mark the grant used.
   */
  migrateGrantId?: string
  /** The product the subscription is on right now (subscription events). */
  productId?: string
  /** Provider invoice/order ID (for payment events). */
  invoiceId?: string
  /**
   * Amount actually charged, in minor units (payment events). 0 for a
   * trial's $0 invoice; omitted when the provider does not report it.
   */
  amountPaid?: number
  /**
   * Why the provider charged (payment events): `subscription_create` is the
   * order that starts a subscription (a trial's $0 one included),
   * `subscription_cycle` a period's charge — the trial's conversion among
   * them, $0 too under a 100 % discount. Omitted when not reported.
   */
  billingReason?: 'subscription_create' | 'subscription_cycle' | 'subscription_update' | 'other'
  /**
   * Meter names the subscription carries a metered price for. A
   * subscription keeps the prices it was created with, so this is what the
   * provider can actually invoice — not what the product sells today.
   * Omitted when the provider does not report prices; overage is then only
   * gated by the trial (`server/utils/overage-lock.ts`).
   */
  billableMeters?: string[]
  /**
   * The event is about a companion usage subscription (see
   * `CompanionSubscriptionInput`), not the plan subscription. The webhook
   * records it beside the account and never lets it write the account's own
   * subscription fields, status, period or plan.
   */
  companion?: boolean
}

/**
 * A monthly, $0-base usage subscription opened beside a yearly plan: the
 * provider invoices metered usage on a subscription's own cycle, so a yearly
 * subscription alone would bill overage once a year. The companion carries the
 * plan's monthly meter credits and the metered prices; the plan subscription
 * keeps the fixed yearly fee. Off unless configured (`companionUsage`).
 */
export interface CompanionSubscriptionInput {
  workspaceId: string
  plan: 'starter' | 'pro'
  customerId: string
  /** The plan subscription the companion belongs to. */
  parentSubscriptionId: string
  /**
   * The product the plan subscription is on now: only a yearly (or bundle) product gets a companion. Omitted by
   * callers that do not know it (the reconciler): the provider reads it from the subscription.
   */
  parentProductId?: string
}

export interface CompanionSubscriptionResult {
  subscriptionId: string
  /** False when the customer already had an active companion (a repeat). */
  created: boolean
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
  /** Ends the subscription now. `already_ended` when the provider reports it was already ended or is gone (not an error: the goal is met). */
  cancelSubscription: (subscriptionId: string) => Promise<'canceled' | 'already_ended'>

  /**
   * Open a Migrate bundle checkout (see `BundleCheckoutInput`). Providers
   * without ad-hoc recurring prices throw: the bundle is Polar-only.
   */
  createBundleCheckout: (input: BundleCheckoutInput) => Promise<BundleCheckoutResult>

  /**
   * Move a bundle subscription to the plan's yearly list product, effective at
   * the next period (no charge now). The first invoice stays what it was; the
   * renewal is the list price. Idempotent: a subscription already on the
   * product is left alone. Returns the product the subscription ends on.
   */
  moveBundleSubscriptionToList: (subscriptionId: string, plan: 'starter' | 'pro') => Promise<{ productId: string, alreadyOnList: boolean }>

  /**
   * Record a usage event for metered/overage billing.
   *
   * Plugins map this to their native model — Polar ingests to a meter
   * via its events API; Stripe does not support real-time metering
   * and logs a warning (overage billing is no-op under Stripe).
   */
  ingestUsageEvent: (input: UsageEventInput) => Promise<void>

  /**
   * Open the monthly usage subscription beside a yearly plan subscription
   * (`CompanionSubscriptionInput`). Idempotent: an active companion for the
   * customer is returned, not duplicated. Null when companions are off, the
   * plan has no companion product, or the parent is not on a yearly product.
   * Optional: a provider without it never has one.
   */
  ensureCompanionSubscription?: (input: CompanionSubscriptionInput) => Promise<CompanionSubscriptionResult | null>
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
