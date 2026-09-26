/**
 * Studio included with a Contentrain Migrate order — the pieces the claim
 * and grant-checkout routes share. Lifecycle: migration 031.
 */
import type { DatabaseRow } from '../providers/database'
import { resolveDeployment } from './deployment'

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
  plan: 'starter' | 'pro'
  trialDays: number
  repo: { owner: string, name: string }
  email: string
  workspaceId: string | null
  state: MigrateGrantState
}

/** What the claim screen may see of a grant. */
export function migrateGrantView(row: DatabaseRow): MigrateGrantView {
  const state: MigrateGrantState = row.redeemed_at ? 'redeemed' : row.bound_at ? 'bound' : 'claimed'
  return {
    id: row.id as string,
    plan: row.plan as 'starter' | 'pro',
    trialDays: row.trial_days as number,
    repo: { owner: row.repo_owner as string, name: row.repo_name as string },
    email: row.email as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    state,
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
  const repo = `${row.repo_owner as string}/${row.repo_name as string}`.toLowerCase()
  const projects = await db.listWorkspaceProjects(session.accessToken, workspaceId)
  const project = projects.find(p => typeof p.repo_full_name === 'string' && p.repo_full_name.toLowerCase() === repo)
  return { workspaceSlug: workspace.slug as string, projectId: (project?.id as string | undefined) ?? null }
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
