/**
 * Studio included with a Contentrain Migrate order — the pieces the claim
 * and grant-checkout routes share. Lifecycle: migration 031.
 */
import type { MigrateStudioCommentsExport } from '@contentrain/types'
import type { DatabaseRow, MigrateCommentsExportRow } from '../providers/database'
import { resolveDeployment } from './deployment'
import { isBillingLocked } from './billing'
import { resolveWorkspaceBilling } from './workspace-billing'

/**
 * Migrate's public key, or null when claim links are off here: no key
 * configured, or a deployment that does not sell subscriptions (a grant is
 * a provider trial, which only a subscription deployment has).
 */
export function migrateClaimPublicKey(): string | null {
  const config = useRuntimeConfig() as unknown as { migrate?: { claimPublicKey?: string } }
  const raw = config.migrate?.claimPublicKey?.trim()
  if (!raw) return null
  if (resolveDeployment().planSource !== 'subscription') return null
  // Env files often carry a PEM on one line with literal "\n".
  return raw.replace(/\\n/g, '\n')
}

export type MigrateGrantState = 'claimed' | 'bound' | 'redeemed'

export interface MigrateGrantView {
  id: string
  /** `bundle`: Studio was part of the order itself (no included trial to start). */
  kind: 'trial' | 'bundle'
  plan: 'starter' | 'pro'
  /** Null for a bundle grant (it opens no included trial). */
  trialDays: number | null
  /** Null for a bundle grant until the delivery repository reaches Studio. */
  repo: { owner: string, name: string } | null
  email: string
  workspaceId: string | null
  state: MigrateGrantState
  /**
   * How writing studio.json to the delivered site went (049, `migrate-site-binding.ts`); absent until it was tried.
   * `prUrl`: the pull request to merge (`pr_open`); `overLimit`: the form models the plan does not serve (`partial`).
   */
  siteBinding?: { state: string, prUrl: string | null, overLimit: string[], limit: number | null }
}

/** What the claim screen may see of a grant. */
export function migrateGrantView(row: DatabaseRow): MigrateGrantView {
  const state: MigrateGrantState = row.redeemed_at ? 'redeemed' : row.bound_at ? 'bound' : 'claimed'
  return {
    id: row.id as string,
    kind: row.kind === 'bundle' ? 'bundle' : 'trial',
    plan: row.plan as 'starter' | 'pro',
    trialDays: (row.trial_days as number | null) ?? null,
    repo: row.repo_owner && row.repo_name ? { owner: row.repo_owner as string, name: row.repo_name as string } : null,
    email: row.email as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    state,
    ...(typeof row.site_binding_state === 'string' ? { siteBinding: siteBindingView(row.site_binding_state, row.site_binding_detail) } : {}),
  }
}

/** Only what the claim screen says: the state, the pull request's address, the form models over the plan and its limit. */
function siteBindingView(state: string, raw: unknown): NonNullable<MigrateGrantView['siteBinding']> {
  const detail = (raw && typeof raw === 'object' ? raw : {}) as { prUrl?: unknown, overLimit?: unknown, limit?: unknown }
  return {
    state,
    limit: typeof detail.limit === 'number' ? detail.limit : null,
    prUrl: typeof detail.prUrl === 'string' && detail.prUrl.startsWith('https://') ? detail.prUrl : null,
    overLimit: Array.isArray(detail.overLimit) ? detail.overLimit.filter((id): id is string => typeof id === 'string') : [],
  }
}

/** Where the delivered site is in Studio: the grant's workspace, and the project connected to its repo there. */
export interface MigrateGrantDestination {
  workspaceSlug: string
  projectId: string | null
}

/**
 * The way from the claim screen to the delivered site, once the grant is
 * tied to a workspace: that workspace, and the project whose repository is
 * the grant's — null until the repo is connected. Read as the caller (a
 * workspace they no longer administer gives nothing).
 */
export async function migrateGrantDestination(session: { accessToken: string, user: { id: string } }, row: DatabaseRow): Promise<MigrateGrantDestination | null> {
  const workspaceId = row.workspace_id as string | null
  if (!workspaceId) return null
  const db = useDatabaseProvider()
  const workspace = await db.getWorkspaceForUser(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'], 'id, slug')
  if (!workspace) return null
  // A bundle grant has no repository until delivery: no project to point at yet.
  if (!row.repo_owner || !row.repo_name) return { workspaceSlug: workspace.slug as string, projectId: null }
  const repo = `${row.repo_owner as string}/${row.repo_name as string}`.toLowerCase()
  const projects = await db.listWorkspaceProjects(session.accessToken, workspaceId)
  const project = projects.find(p => typeof p.repo_full_name === 'string' && p.repo_full_name.toLowerCase() === repo)
  return { workspaceSlug: workspace.slug as string, projectId: (project?.id as string | undefined) ?? null }
}

/**
 * Where a bundle grant's Studio plan stands, for the claim screen. The site lives in the grant's workspace
 * and follows that workspace's plan like any other project, by the workspace's billing state:
 * - `active`: the subscription runs (also a trial, and `past_due` while its grace period lasts: still accessible).
 * - `ending`: set to end at the period's end (`cancel_at_period_end`), or canceled with the paid period still
 *   running. `periodEndsAt` is when.
 * - `ended`: only what locks the workspace — canceled and past its period, grace period over, trial over — or no
 *   subscription at all.
 */
export interface MigrateBundleStatus {
  planState: 'active' | 'ending' | 'ended'
  workspaceSlug: string
  /** When the running plan's current period ends, seconds since the epoch; null when it has no running period. */
  periodEndsAt: number | null
}

export async function migrateBundleStatus(row: DatabaseRow): Promise<MigrateBundleStatus | null> {
  const workspaceId = row.workspace_id as string | null
  if (row.kind !== 'bundle' || !workspaceId) return null
  const db = useDatabaseProvider()
  const workspace = await db.getWorkspaceById(workspaceId, 'id, slug, type, plan, overage_settings')
  if (!workspace) return null
  const billing = await resolveWorkspaceBilling(db, { ...workspace, id: workspaceId })
  const slug = workspace.slug as string
  // No subscription (a free workspace), or one that locks the workspace.
  if (billing.state === 'free' || isBillingLocked(billing.state)) return { planState: 'ended', workspaceSlug: slug, periodEndsAt: null }

  const account = await db.getActivePaymentAccount(workspaceId)
  const end = account?.current_period_end ? Date.parse(String(account.current_period_end)) : Number.NaN
  const periodEndsAt = Number.isFinite(end) ? Math.floor(end / 1000) : null
  const ending = billing.state === 'canceled' || account?.cancel_at_period_end === true
  return { planState: ending ? 'ending' : 'active', workspaceSlug: slug, periodEndsAt }
}

/**
 * The origin Migrate signed for a project's site: from the grant bound to the
 * project's workspace for its repository. Null for a project no grant covers.
 */
export async function migrationSignedOrigin(workspaceId: string, project: { repo_full_name?: unknown }): Promise<string | null> {
  const repo = typeof project.repo_full_name === 'string' ? project.repo_full_name : ''
  if (!repo.includes('/')) return null
  return useDatabaseProvider().getMigrateGrantOrigin(workspaceId, repo)
}

/**
 * What the claim screen says about the site's comments. `pending` while the
 * export is being taken onto the grant; `unavailable` means the file upload.
 * Null when the claim had no comments export.
 */
export interface MigrateClaimCommentsView {
  status: 'pending' | MigrateCommentsExportRow['status']
  count: number
}

export function claimCommentsView(
  stored: MigrateCommentsExportRow | null,
  pointer?: MigrateStudioCommentsExport,
  warnings: string[] = [],
): MigrateClaimCommentsView | null {
  // Held or imported already: a later claim for the order does not fetch again.
  if (stored && (stored.status === 'ready' || stored.status === 'imported')) return { status: stored.status, count: stored.comments }
  if (pointer) return { status: 'pending', count: pointer.comments }
  if (warnings.some(w => w.startsWith('comments_export'))) return { status: 'unavailable', count: 0 }
  return stored ? { status: stored.status, count: stored.comments } : null
}
