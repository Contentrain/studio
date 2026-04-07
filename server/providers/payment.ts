/**
 * PaymentProvider interface.
 *
 * Abstracts payment/subscription management.
 * Current implementation: Stripe.
 * Alternative implementations: Paddle, LemonSqueezy, etc.
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
  stripeCustomerId: string
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
  /** Stripe subscription status: trialing, active, past_due, canceled, unpaid, incomplete */
  subscriptionStatus?: string
  /** ISO timestamp: when current billing period ends */
  currentPeriodEnd?: string
  /** Whether subscription will cancel at period end */
  cancelAtPeriodEnd?: boolean
  /** Stripe invoice ID (for payment events) */
  invoiceId?: string
  /** Whether this event requires overage calculation (invoice.creating) */
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
  /**
   * Create a checkout session for plan subscription.
   */
  createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult>

  /**
   * Create a customer portal session for subscription management.
   */
  createPortalSession(input: PortalInput): Promise<PortalResult>

  /**
   * Verify and process a webhook event.
   */
  handleWebhook(payload: string, signature: string): Promise<WebhookResult>

  /**
   * Cancel a subscription.
   */
  cancelSubscription(subscriptionId: string): Promise<void>

  /**
   * Add a one-time invoice item to the customer's upcoming invoice.
   * Used for overage billing at the end of a billing period.
   */
  addInvoiceItem(input: InvoiceItemInput): Promise<{ invoiceItemId: string }>
}
