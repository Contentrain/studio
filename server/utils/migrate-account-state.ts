/**
 * What Studio tells Migrate about an account before Migrate prices the bundle
 * (W54): does the GitHub account that will own the delivery already have a
 * Studio plan, and does it cover the plan discovery sized?
 *
 * - `none`: no Studio account, or none with a running paid plan → the Studio
 *   line is year 1 of the sized plan.
 * - `covers`: a running plan at least the sized one → nothing is added.
 * - `too_small`: a running plan below it → the upgrade difference.
 *
 * "Running" is a subscription that is paid up or still inside its paid
 * period (`subscribed`, `past_due`, `canceled`). A trial or a locked
 * workspace counts as no plan; the provision step (S3) settles what happens
 * to an existing trial subscription.
 */
import type { MigrateAccountStateResponse, MigrateStudioPlan } from '@contentrain/types'
import { bundleUpgradeCents, bundleYear1Cents, planCovers } from '../../shared/utils/migrate-bundle'
import { resolveWorkspaceBilling } from './workspace-billing'

const RUNNING_STATES = new Set(['subscribed', 'past_due', 'canceled'])

/** The highest Studio plan, among the user's owned workspaces, that is actually running. */
export async function highestRunningPlan(userId: string): Promise<MigrateStudioPlan | null> {
  const db = useDatabaseProvider()
  const workspaces = await db.listOwnedWorkspacesAdmin(userId)
  let best: MigrateStudioPlan | null = null
  for (const workspace of workspaces) {
    const billing = await resolveWorkspaceBilling(db, { ...workspace, id: String(workspace.id) })
    if (!RUNNING_STATES.has(billing.state)) continue
    const plan = billing.effectivePlan
    // Enterprise is above everything Migrate sells.
    const sold: MigrateStudioPlan | null = plan === 'enterprise' || plan === 'pro' ? 'pro' : plan === 'starter' ? 'starter' : null
    if (sold && (!best || planCovers(sold, best))) best = sold
  }
  return best
}

export async function resolveMigrateAccountState(githubUserId: string, plan: MigrateStudioPlan): Promise<MigrateAccountStateResponse> {
  const user = await useAuthProvider().getUserByProviderAccount('github', githubUserId)
  const current = user ? await highestRunningPlan(user.id) : null

  if (!current) return { state: 'none', plan, year1_cents: bundleYear1Cents(plan) }
  if (planCovers(current, plan)) return { state: 'covers', plan: current, year1_cents: 0, current_plan: current }
  return { state: 'too_small', plan, year1_cents: bundleUpgradeCents(plan, current), current_plan: current }
}
