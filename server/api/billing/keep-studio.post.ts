/**
 * POST /api/billing/keep-studio
 *
 * "Keep Studio" after a prepaid Studio year: opens a checkout for the yearly plan of the owner's choice, with
 * a trial that ends when the year does. Open from 30 days before the year's end. See
 * `startPrepaidRenewalCheckout`.
 */
import { startPrepaidRenewalCheckout } from '../../utils/migrate-prepaid-renewal'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()

  const body = await readBody<{ workspaceId?: string, plan?: 'starter' | 'pro' }>(event)
  if (!body?.workspaceId || !body.plan || !['starter', 'pro'].includes(body.plan)) {
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })
  }

  // Only owner/admin can create checkout sessions
  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    body.workspaceId,
    ['owner', 'admin'],
    'id, slug, name, prepaid_until',
  )
  if (!workspace) {
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  }

  return startPrepaidRenewalCheckout({
    workspace: workspace as { id: string, slug: string, name: string, prepaid_until?: unknown },
    plan: body.plan,
    customerEmail: session.user.email ?? '',
  })
})
