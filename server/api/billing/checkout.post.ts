/**
 * POST /api/billing/checkout
 *
 * Creates a checkout session for plan subscription via the active
 * payment plugin (Polar by default, Stripe as fallback). Returns the
 * hosted checkout URL for the client to redirect to.
 */
import { startPlanCheckout } from '../../utils/plan-checkout'

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
    'id, slug, name, trial_consumed_at',
  )

  if (!workspace) {
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  }

  const ws = workspace as { id: string, slug: string, name: string, trial_consumed_at?: string | null }

  // Grant the free trial only if this workspace has never used one. A
  // returning customer (trial canceled/expired) gets a paid checkout with
  // no new trial — closes the cancel→re-trial loop.
  return startPlanCheckout({
    workspace: { id: body.workspaceId, slug: ws.slug, name: ws.name },
    plan: body.plan,
    customerEmail: session.user.email ?? '',
    withTrial: !ws.trial_consumed_at,
    successPath: `/w/${ws.slug}/settings?billing=success`,
    cancelPath: `/w/${ws.slug}/settings?billing=cancelled`,
  })
})
