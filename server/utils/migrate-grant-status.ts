/**
 * Where a Migrate grant stands, for Migrate's status call and its install-URL
 * gate. Lifecycle: migration 031 (claimed → bound → redeemed). `revoked` is
 * part of the contract; no stored status maps to it until the revoke column
 * exists.
 */
import type { MigrateGrantState } from '@contentrain/types'
import type { DatabaseRow } from '../providers/database'

export function migrateGrantStateOf(grant: DatabaseRow): MigrateGrantState {
  return grant.redeemed_at ? 'redeemed' : grant.bound_at ? 'bound' : 'claimed'
}

/** The workspace row for a bound grant, with whether Studio's GitHub App is installed on it. */
export async function migrateGrantInstallation(grant: DatabaseRow): Promise<{ workspace: DatabaseRow | null, installed: boolean }> {
  const workspaceId = grant.workspace_id as string | null
  if (!workspaceId) return { workspace: null, installed: false }
  const workspace = await useDatabaseProvider().getWorkspaceById(workspaceId, 'id, slug, github_installation_id')
  return { workspace, installed: workspace?.github_installation_id != null }
}
