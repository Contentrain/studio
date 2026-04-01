/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Customer Portal session.
 * Allows users to manage their subscription, update payment, cancel.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  const body = await readBody<{ workspaceId: string }>(event)

  if (!body.workspaceId) {
    throw createError({ statusCode: 400, message: 'Workspace ID is required.' })
  }

  // Only owner/admin can access billing portal
  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    body.workspaceId,
    ['owner', 'admin'],
  )

  if (!workspace) {
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  }

  const stripeCustomerId = (workspace as { stripe_customer_id?: string }).stripe_customer_id
  if (!stripeCustomerId) {
    throw createError({ statusCode: 400, message: 'No active subscription found. Please subscribe first.' })
  }

  const { createStripePaymentProvider } = await import('../../providers/stripe-payment')
  const payment = createStripePaymentProvider()

  const config = useRuntimeConfig()
  const siteUrl = config.public.siteUrl as string
  const wsSlug = (workspace as { slug: string }).slug

  const result = await payment.createPortalSession({
    workspaceId: body.workspaceId,
    stripeCustomerId,
    returnUrl: `${siteUrl}/w/${wsSlug}/settings`,
  })

  return { url: result.url }
})
