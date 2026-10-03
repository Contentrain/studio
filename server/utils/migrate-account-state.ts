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
import { STUDIO_YEARLY_LIST_CENTS, bundleUpgradeCents, bundleYear1Cents, planCovers } from '../../shared/utils/migrate-bundle'
import { resolveWorkspaceBilling } from './workspace-billing'

const RUNNING_STATES = new Set(['subscribed', 'past_due', 'canceled'])

interface RunningPlan { plan: MigrateStudioPlan, workspaceId: string, primary: boolean }

/** The user's owned workspaces whose plan is actually running, with the sold plan each one holds. */
async function runningPlans(userId: string): Promise<RunningPlan[]> {
  const db = useDatabaseProvider()
  const workspaces = await db.listOwnedWorkspacesAdmin(userId)
  const running: RunningPlan[] = []
  for (const workspace of workspaces) {
    const billing = await resolveWorkspaceBilling(db, { ...workspace, id: String(workspace.id) })
    if (!RUNNING_STATES.has(billing.state)) continue
    const plan = billing.effectivePlan
    // Enterprise is above everything Migrate sells.
    const sold: MigrateStudioPlan | null = plan === 'enterprise' || plan === 'pro' ? 'pro' : plan === 'starter' ? 'starter' : null
    if (sold) running.push({ plan: sold, workspaceId: String(workspace.id), primary: workspace.type === 'primary' })
  }
  return running
}

/** The highest Studio plan, among the user's owned workspaces, that is actually running. */
export async function highestRunningPlan(userId: string): Promise<MigrateStudioPlan | null> {
  let best: MigrateStudioPlan | null = null
  for (const { plan } of await runningPlans(userId)) if (!best || planCovers(plan, best)) best = plan
  return best
}

/** The workspace a covered order joins: the account's personal workspace if its plan covers `needed`, else the first owned one that does. */
export async function coveringWorkspace(userId: string, needed: MigrateStudioPlan): Promise<{ id: string, slug: string } | null> {
  const covering = (await runningPlans(userId)).filter(r => planCovers(r.plan, needed))
  const chosen = covering.find(r => r.primary) ?? covering[0]
  if (!chosen) return null
  const row = await useDatabaseProvider().getWorkspaceById(chosen.workspaceId, 'id, slug')
  return row ? { id: String(row.id), slug: String(row.slug) } : null
}

/**
 * `renewal_cents` is the yearly list price the subscription renews at after
 * the discounted first year (0 when nothing is added). Migrate may not compute
 * it; it shows Studio's number. Not in `@contentrain/types` yet — extra key.
 */
export type MigrateAccountStateWithRenewal = MigrateAccountStateResponse & { renewal_cents: number }

export async function resolveMigrateAccountState(githubUserId: string, plan: MigrateStudioPlan): Promise<MigrateAccountStateWithRenewal> {
  const user = await useAuthProvider().getUserByProviderAccount('github', githubUserId)
  const current = user ? await highestRunningPlan(user.id) : null

  if (!current) return { state: 'none', plan, year1_cents: bundleYear1Cents(plan), renewal_cents: STUDIO_YEARLY_LIST_CENTS[plan] }
  if (planCovers(current, plan)) return { state: 'covers', plan: current, year1_cents: 0, renewal_cents: 0, current_plan: current }
  return { state: 'too_small', plan, year1_cents: bundleUpgradeCents(plan, current), renewal_cents: STUDIO_YEARLY_LIST_CENTS[plan], current_plan: current }
}
