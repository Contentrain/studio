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

export interface WebhookResult {
  event: string
  workspaceId?: string
  plan?: string
  subscriptionId?: string
  customerId?: string
  /** Provider-normalised status: trialing, active, past_due, canceled, unpaid, incomplete. */
  subscriptionStatus?: string
  /** ISO timestamp: when current billing period ends. */
  currentPeriodEnd?: string
  /** Whether subscription will cancel at period end. */
  cancelAtPeriodEnd?: boolean
  /** Provider invoice/order ID (for payment events). */
  invoiceId?: string
  /** Legacy flag — Stripe uses `invoice.creating` for overage billing. */
  requiresOverageCalculation?: boolean
}

export interface InvoiceItemInput {
  customerId: string
  subscriptionId: string
  description: string
  /** Amount in cents (USD). */
  amount: number
  currency?: string
  metadata?: Record<string, string>
}

export interface PaymentProvider {
  /** Create a checkout session for plan subscription. */
  createCheckoutSession: (input: CheckoutInput) => Promise<CheckoutResult>

  /** Create a customer portal session for subscription management. */
  createPortalSession: (input: PortalInput) => Promise<PortalResult>

  /** Verify and process a webhook event. */
  handleWebhook: (payload: string, signature: string) => Promise<WebhookResult>

  /** Cancel a subscription. */
  cancelSubscription: (subscriptionId: string) => Promise<void>

  /**
   * Add a one-time invoice item to the customer's upcoming invoice.
   * Used for overage billing at the end of a billing period.
   * Legacy shape — Polar and other providers map this onto their native
   * meter/adjustment model inside the plugin.
   */
  addInvoiceItem: (input: InvoiceItemInput) => Promise<{ invoiceItemId: string }>
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
