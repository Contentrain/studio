/**
 * Where a Migrate grant stands, for Migrate's status call and its install-URL
 * gate. Lifecycle: migration 031 (claimed → bound → redeemed), and `revoked`
 * (migration 045) from any of them, which wins over the rest.
 */
import type { MigrateGrantState, MigrateGrantStatusResponse } from '@contentrain/types'
import type { DatabaseRow, MigrateGrantMediaState as GrantMediaRowState } from '../providers/database'
import { migrateBundleStatus } from './migrate-grant'
import { useGitAppProvider } from './providers'

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
  /**
   * The GitHub account (login) the workspace's Studio GitHub App is installed on, so Migrate's delivery can
   * default to it: a workspace connects one account, and a repository delivered elsewhere cannot be connected.
   * Only when the workspace has an installation and GitHub answered; absent otherwise.
   */
  workspace_github_account?: { login: string, type: 'User' | 'Organization' }
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

/** The GitHub account the grant's workspace has installed Studio's app on; null when none or unknown. */
export async function migrateGrantGithubAccount(workspace: DatabaseRow | null): Promise<{ login: string, type: 'User' | 'Organization' } | null> {
  const installationId = workspace?.github_installation_id
  if (typeof installationId !== 'number') return null
  try {
    const { account } = await useGitAppProvider(installationId).getInstallationDetails()
    if (!account.login) return null
    return { login: account.login, type: account.type === 'Organization' ? 'Organization' : 'User' }
  }
  catch {
    // The status answer is Migrate's; a GitHub hiccup leaves the account out rather than failing it.
    return null
  }
}

/**
 * Where the delivered site's Studio capabilities stand, for Migrate's "turn off WordPress" checklist
 * (`MigrateGrantStatusResponse.capabilities`). A key is sent only for a capability Studio
 * serves on this site; an absent key reads as `pending`.
 * - `forms`: the site has form models (the binding counted them). `connected` once studio.json on the default branch
 *   names this project (`written`, or `partial` when the plan serves fewer forms than the site has).
 * - `comments`: the order had a comments export. `connected` once the site is bound the same way and the export is
 *   imported into the project.
 * - `media`: the grant's `media_state` (053) in the contract's words; no key before the first pass or with nothing
 *   to move (`none`). A failed start that is still being tried again is `pending`, like one not started yet.
 */
export type MigrateGrantCapabilities = NonNullable<MigrateGrantStatusResponse['capabilities']>

const MEDIA_CAPABILITY: Partial<Record<GrantMediaRowState, MigrateGrantCapabilities['media']>> = {
  importing: 'pending',
  failed: 'pending',
  pending: 'pending',
  paused_quota: 'paused',
  review: 'review',
  connected: 'connected',
}

export async function migrateGrantCapabilities(grant: DatabaseRow): Promise<MigrateGrantCapabilities> {
  if (grant.kind !== 'bundle') return {}
  const state = grant.site_binding_state as string | null
  const detail = (grant.site_binding_detail && typeof grant.site_binding_detail === 'object' ? grant.site_binding_detail : {}) as { formModels?: unknown }
  const bound = state === 'written' || state === 'partial'
  const capabilities: MigrateGrantCapabilities = {}
  if (typeof detail.formModels === 'number' && detail.formModels > 0) capabilities.forms = bound ? 'connected' : 'pending'
  const comments = await useDatabaseProvider().getMigrateCommentsExportState(grant.id as string)
  if (comments) capabilities.comments = bound && comments.status === 'imported' ? 'connected' : 'pending'
  const media = MEDIA_CAPABILITY[grant.media_state as GrantMediaRowState]
  if (media) capabilities.media = media
  return capabilities
}

/** Enough to read every failed item of one import: a manifest names far fewer old-site files. */
const FAILED_ITEMS_LIMIT = 10_000

/**
 * `media_refused_too_large`: of the old-site files Migrate offered, how many Studio refused as larger than the plan
 * takes for one file. Those known before fetching (`media_detail.refusedTooLarge`, `refusedTooLargeOf`) plus those
 * refused on download (the job's failed old-site items, 413). Other failures are not counted. 0 when none; absent
 * before the grant's media has a job, or when the count could not be read for an owner's job.
 */
export async function migrateGrantMediaRefusedTooLarge(grant: DatabaseRow): Promise<number | undefined> {
  if (grant.kind !== 'bundle') return undefined
  const detail = (grant.media_detail && typeof grant.media_detail === 'object' ? grant.media_detail : {}) as { jobId?: unknown, refusedTooLarge?: unknown }
  if (typeof detail.jobId !== 'string' || typeof detail.refusedTooLarge !== 'number') return undefined
  const failed = await useDatabaseProvider().listMigrationMediaItems(detail.jobId, 'failed', FAILED_ITEMS_LIMIT)
  return detail.refusedTooLarge + failed.filter(item => item.source_url && Number(item.status_code) === 413).length
}
