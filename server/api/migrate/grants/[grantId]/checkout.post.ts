/**
 * POST /api/migrate/grants/:grantId/checkout
 *
 * Start the included trial a Migrate grant carries, on a workspace the
 * caller owns or administers: the grant's plan, at its regular price, with
 * the grant's trial length ($0 today). The card is collected by the
 * provider, the subscription continues at the regular price when the trial
 * ends unless canceled.
 *
 * The first call binds the grant to the workspace (for good — an abandoned
 * checkout can be reopened there, not elsewhere). The subscription it
 * creates carries `migrate_grant_id`; the billing webhook then marks the
 * grant redeemed, after which it opens no further checkout.
 *
 * The trial is the grant's own entitlement, so a workspace that used its
 * one-time trial before still gets it; everything else — no second
 * subscription, throttling, provider errors — is the plan checkout's.
 */
import { migrateClaimPublicKey } from '../../../../utils/migrate-grant'
import { startPlanCheckout } from '../../../../utils/plan-checkout'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  if (!migrateClaimPublicKey())
    throw createError({ statusCode: 404, message: errorMessage('migrate.unavailable') })

  const grantId = getRouterParam(event, 'grantId') ?? ''
  const body = await readBody<{ workspaceId?: unknown }>(event)
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : ''
  if (!grantId || !workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const db = useDatabaseProvider()
  const grant = await db.getMigrateGrantForUser(grantId, session.user.id)
  if (!grant) throw createError({ statusCode: 404, message: errorMessage('migrate.grant_not_found') })

  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    workspaceId,
    ['owner', 'admin'],
    'id, slug, name',
  )
  if (!workspace) throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })

  if (grant.redeemed_at)
    throw createError({ statusCode: 409, message: errorMessage('migrate.grant_used') })
  if (grant.bound_at && grant.workspace_id !== workspaceId)
    throw createError({ statusCode: 409, message: errorMessage('migrate.grant_bound_elsewhere') })

  // Checked before binding too (the plan checkout checks it again): a
  // grant tied to a workspace that already pays could never be used.
  const account = await db.getActivePaymentAccount(workspaceId)
  const status = account?.subscription_status as string | null | undefined
  if (account?.subscription_id && status && !['canceled', 'incomplete_expired'].includes(status))
    throw createError({ statusCode: 409, message: errorMessage('billing.subscription_exists') })

  const bound = await db.bindMigrateGrantWorkspace(grantId, workspaceId)
  if (!bound) throw createError({ statusCode: 409, message: errorMessage('migrate.grant_bound_elsewhere') })

  const ws = workspace as { slug: string, name: string }
  return startPlanCheckout({
    workspace: { id: workspaceId, slug: ws.slug, name: ws.name },
    plan: bound.plan as 'starter' | 'pro',
    customerEmail: session.user.email ?? '',
    withTrial: true,
    trialDays: bound.trial_days as number,
    metadata: { migrate_grant_id: grantId },
    // Back on the dashboard, where the delivered repo gets connected.
    successPath: `/w/${ws.slug}?billing=success`,
    cancelPath: `/migrate/claim?grant=${grantId}`,
  })
})
