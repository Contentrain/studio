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
