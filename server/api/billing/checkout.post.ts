/**
 * POST /api/billing/checkout
 *
 * Creates a checkout session for plan subscription via the active
 * payment plugin (Polar by default, Stripe as fallback). Returns the
 * hosted checkout URL for the client to redirect to.
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
    'id, slug, name',
  )

  if (!workspace) {
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  }

  // Guard: prevent duplicate subscriptions via the active payment account.
  const account = await db.getActivePaymentAccount(body.workspaceId)
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
  const rateCheck = await checkRateLimit(`checkout:${body.workspaceId}`, 1, 30_000)
  if (!rateCheck.allowed) {
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })
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
