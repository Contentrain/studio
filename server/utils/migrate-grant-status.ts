/**
 * Where a Migrate grant stands, for Migrate's status call and its install-URL
 * gate. Lifecycle: migration 031 (claimed → bound → redeemed), and `revoked`
 * (migration 045) from any of them, which wins over the rest.
 */
import type { MigrateGrantState } from '@contentrain/types'
import type { DatabaseRow } from '../providers/database'
import { migrateBundleStatus } from './migrate-grant'

export function migrateGrantStateOf(grant: DatabaseRow): MigrateGrantState {
  if (grant.revoked_at) return 'revoked'
  return grant.redeemed_at ? 'redeemed' : grant.bound_at ? 'bound' : 'claimed'
}

/** The workspace row for a bound grant, with whether Studio's GitHub App is installed on it. */
export async function migrateGrantInstallation(grant: DatabaseRow): Promise<{ workspace: DatabaseRow | null, installed: boolean }> {
  const workspaceId = grant.workspace_id as string | null
  if (!workspaceId) return { workspace: null, installed: false }
  const workspace = await useDatabaseProvider().getWorkspaceById(workspaceId, 'id, slug, github_installation_id')
  return { workspace, installed: workspace?.github_installation_id != null }
}

/**
 * What Migrate shows besides the state (additive to `MigrateGrantStatusResponse`):
 * - `kind`: `trial` (included days), `bundle` (Studio year paid with the order) or `covered` (the order was
 *   covered by a plan the account already had: a bundle grant redeemed with no subscription of its own).
 * - `ends_at`: the trial's end, or the end of the workspace plan's running period (seconds since the epoch).
 * - `ended` + `notice`: the plan the site lives on has ended; `notice` is Studio's own text, shown as is.
 */
export interface MigrateGrantStatusDetail {
  kind: 'trial' | 'bundle' | 'covered'
  plan: 'starter' | 'pro'
  trial_days?: number
  ends_at?: number
  ended?: boolean
  notice?: string
}

export async function migrateGrantStatusDetail(grant: DatabaseRow): Promise<MigrateGrantStatusDetail> {
  const plan = grant.plan as 'starter' | 'pro'
  if (grant.kind !== 'bundle') {
    const detail: MigrateGrantStatusDetail = { kind: 'trial', plan }
    if (typeof grant.trial_days === 'number') detail.trial_days = grant.trial_days
    const workspaceId = grant.workspace_id as string | null
    const account = workspaceId && grant.redeemed_at ? await useDatabaseProvider().getActivePaymentAccount(workspaceId) : null
    const end = account?.trial_ends_at ? Date.parse(String(account.trial_ends_at)) : Number.NaN
    if (Number.isFinite(end)) detail.ends_at = Math.floor(end / 1000)
    return detail
  }
  const detail: MigrateGrantStatusDetail = { kind: grant.redeemed_at && !grant.redeemed_subscription_id ? 'covered' : 'bundle', plan }
  const status = await migrateBundleStatus(grant)
  if (!status) return detail
  if (status.periodEndsAt) detail.ends_at = status.periodEndsAt
  if (status.planState === 'ended') {
    detail.ended = true
    detail.notice = errorMessage('migrate.bundle_plan_ended_notice')
  }
  return detail
}
