/**
 * Start a plan checkout for a workspace — the part every checkout entry
 * shares (`/api/billing/checkout`, a Migrate grant's checkout): refuse a
 * second subscription, throttle double clicks, and turn a provider failure
 * into a clean 502. The caller decides the trial.
 */
import type { CheckoutInput } from '../providers/payment/types'

export interface PlanCheckoutInput {
  workspace: { id: string, slug: string, name: string }
  plan: 'starter' | 'pro'
  customerEmail: string
  withTrial: boolean
  trialDays?: number
  metadata?: Record<string, string>
  /** Where the provider sends the customer back, relative to the site. */
  successPath: string
  cancelPath: string
}

export async function startPlanCheckout(input: PlanCheckoutInput): Promise<{ url: string }> {
  const db = useDatabaseProvider()

  // Guard: prevent duplicate subscriptions via the active payment account.
  const account = await db.getActivePaymentAccount(input.workspace.id)
  if (account?.subscription_id) {
    const status = account.subscription_status as string | null
    if (status && !['canceled', 'incomplete_expired'].includes(status)) {
      throw createError({
        statusCode: 409,
        message: errorMessage('billing.subscription_exists'),
      })
    }
  }

  // Rate limit checkout creation per workspace — prevents duplicate sessions from rapid clicks
  const rateCheck = await checkRateLimit(`checkout:${input.workspace.id}`, 1, 30_000)
  if (!rateCheck.allowed) {
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })
  }

  const payment = usePaymentProvider()
  if (!payment) {
    throw createError({ statusCode: 503, message: errorMessage('generic.server_error') })
  }

  const siteUrl = useRuntimeConfig().public.siteUrl as string
  const checkout: CheckoutInput = {
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
    plan: input.plan,
    customerEmail: input.customerEmail,
    successUrl: `${siteUrl}${input.successPath}`,
    cancelUrl: `${siteUrl}${input.cancelPath}`,
    withTrial: input.withTrial,
    ...(input.trialDays ? { trialDays: input.trialDays } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }

  try {
    const result = await payment.createCheckoutSession(checkout)
    return { url: result.url }
  }
  catch (err) {
    // Provider SDK failure (expired/invalid token, provider outage, bad
    // product id). Log the detail server-side and surface a clean message
    // instead of an unhandled 500 that leaks the SDK stack to the client.
    // eslint-disable-next-line no-console -- ops visibility for provider failures
    console.error('[billing-checkout] createCheckoutSession failed:', err)
    throw createError({ statusCode: 502, message: errorMessage('billing.provider_unavailable') })
  }
}
