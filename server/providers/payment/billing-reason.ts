import type { WebhookResult } from './types'

/**
 * A provider's reason for a charge in `WebhookResult` terms. Polar orders and
 * Stripe invoices use the same names for the subscription ones.
 */
export function billingReasonOf(reason: string): NonNullable<WebhookResult['billingReason']> {
  return reason === 'subscription_create' || reason === 'subscription_cycle' || reason === 'subscription_update'
    ? reason
    : 'other'
}
