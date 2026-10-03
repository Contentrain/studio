/**
 * POST /api/migrate/grants/:grantId/attach
 *
 * The included-trial grant of a customer who already pays for Studio: the
 * delivered site joins a workspace whose running plan covers the grant's
 * plan, and no second subscription (and no trial) starts. The grant is tied
 * to the workspace and marked used with no subscription of its own, so the
 * claim screen goes straight to the site. Only a paid, active plan that is not
 * ending qualifies: a trial, a plan set to end at the period's close, or an
 * overdue one is refused with a reason the screen shows (a grant is a one-time
 * credit, and a plan that is about to lapse would take the site's Studio with
 * it). The visitor then fixes the plan, or picks another workspace.
 */
import { migrateClaimPublicKey } from '../../../../utils/migrate-grant'
import { resolveWorkspaceBilling } from '../../../../utils/workspace-billing'
import { planCovers } from '../../../../../shared/utils/migrate-bundle'
import type { MigrateStudioPlan } from '@contentrain/types'

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
    'id, slug, name, type, plan, overage_settings',
  )
  if (!workspace) throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })

  if (grant.revoked_at) throw createError({ statusCode: 409, message: errorMessage('migrate.grant_revoked') })
  if (grant.redeemed_at) throw createError({ statusCode: 409, message: errorMessage('migrate.grant_used') })
  // A bundle grant is paid through Migrate's checkout; it never attaches.
  if (grant.kind === 'bundle') throw createError({ statusCode: 409, message: errorMessage('migrate.grant_bundle') })
  if (grant.bound_at && grant.workspace_id !== workspaceId)
    throw createError({ statusCode: 409, message: errorMessage('migrate.grant_bound_elsewhere') })

  const billing = await resolveWorkspaceBilling(db, { ...workspace, id: workspaceId } as Parameters<typeof resolveWorkspaceBilling>[1])
  if (billing.state === 'past_due') throw createError({ statusCode: 409, message: errorMessage('migrate.attach_past_due') })
  const account = await db.getActivePaymentAccount(workspaceId)
  if (billing.state !== 'subscribed' || account?.cancel_at_period_end === true)
    throw createError({ statusCode: 409, message: errorMessage('migrate.attach_no_plan') })
  const current = billing.effectivePlan === 'enterprise' ? 'pro' : billing.effectivePlan
  if ((current !== 'starter' && current !== 'pro') || !planCovers(current as MigrateStudioPlan, grant.plan as MigrateStudioPlan))
    throw createError({ statusCode: 409, message: errorMessage('migrate.attach_plan_too_small') })

  const bound = await db.bindMigrateGrantWorkspace(grantId, workspaceId)
  if (!bound) throw createError({ statusCode: 409, message: errorMessage('migrate.grant_bound_elsewhere') })
  await db.markMigrateGrantRedeemed(grantId, null)
  return { ok: true, workspaceSlug: (workspace as { slug: string }).slug }
})
