/**
 * POST /api/billing/portal
 *
 * Creates a customer portal session via the active payment plugin.
 * Allows the user to manage their subscription (payment method,
 * cancel, plan change) through the provider's hosted portal.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  const body = await readBody<{ workspaceId: string }>(event)

  if (!body.workspaceId) {
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })
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

  const account = await db.getActivePaymentAccount(body.workspaceId)
  const customerId = (account?.customer_id as string | undefined) ?? ''
  if (!customerId) {
    throw createError({ statusCode: 400, message: errorMessage('billing.no_subscription') })
  }

  const payment = usePaymentProvider()
  if (!payment) {
    throw createError({ statusCode: 503, message: errorMessage('generic.server_error') })
  }

  const config = useRuntimeConfig()
  const siteUrl = config.public.siteUrl as string
  const wsSlug = (workspace as { slug: string }).slug

  const result = await payment.createPortalSession({
    workspaceId: body.workspaceId,
    customerId,
    returnUrl: `${siteUrl}/w/${wsSlug}/settings`,
  })

  return { url: result.url }
})
