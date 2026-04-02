/**
 * POST /api/billing/checkout
 *
 * Creates a Stripe Checkout Session for plan subscription.
 * Redirects the user to Stripe's hosted payment page.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  const body = await readBody<{
    workspaceId: string
    plan: 'starter' | 'pro'
  }>(event)

  if (!body.workspaceId || !body.plan || !['starter', 'pro'].includes(body.plan)) {
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })
  }

  // Only owner/admin can create checkout sessions
  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    body.workspaceId,
    ['owner', 'admin'],
    'id, slug, name, stripe_subscription_id, subscription_status',
  )

  if (!workspace) {
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  }

  // Guard: prevent duplicate subscriptions for the same workspace
  const wsData = workspace as { stripe_subscription_id?: string | null, subscription_status?: string | null }
  if (wsData.stripe_subscription_id && wsData.subscription_status && !['canceled', 'incomplete_expired'].includes(wsData.subscription_status)) {
    throw createError({
      statusCode: 409,
      message: errorMessage('billing.subscription_exists'),
    })
  }

  const payment = usePaymentProvider()
  if (!payment) {
    throw createError({ statusCode: 503, message: errorMessage('generic.server_error') })
  }

  const config = useRuntimeConfig()
  const siteUrl = config.public.siteUrl as string
  const wsSlug = (workspace as { slug: string }).slug

  const result = await payment.createCheckoutSession({
    workspaceId: body.workspaceId,
    workspaceName: (workspace as { name: string }).name,
    plan: body.plan,
    customerEmail: session.user.email ?? '',
    successUrl: `${siteUrl}/w/${wsSlug}/settings?billing=success`,
    cancelUrl: `${siteUrl}/w/${wsSlug}/settings?billing=cancelled`,
  })

  return { url: result.url }
})
