/**
 * Plain-Postgres DatabaseProvider — module bundles.
 *
 * Ported module-by-module against the contract suite (tests/contract), which
 * runs the same specs the Supabase implementation's behavior defines. The
 * factory in server/utils/providers.ts stays pointed at Supabase until every
 * DatabaseProvider method bundle exists; until then this file only assembles
 * what is already ported.
 *
 * Ported so far: profiles, oauth-tokens, audit, trial-reminders,
 * workspaces, members, projects, usage.
 * Next: conversations, cdn/mcp/media/forms, webhooks + payment-accounts.
 */
import { auditMethods } from './audit'
import { memberMethods } from './members'
import { oauthTokenMethods } from './oauth-tokens'
import { profileMethods } from './profiles'
import { projectMethods } from './projects'
import { trialReminderMethods } from './trial-reminders'
import { usageMethods } from './usage'
import { workspaceMethods } from './workspaces'

export { closePostgresDb, configurePostgresDb, getPostgresConfig } from './client'
export type { PostgresDbConfig } from './client'

/** Bundles implemented so far — becomes createPostgresDatabaseProvider() once complete. */
export function postgresDbMethodBundles() {
  return {
    ...profileMethods(),
    ...oauthTokenMethods(),
    ...auditMethods(),
    ...trialReminderMethods(),
    ...workspaceMethods(),
    ...memberMethods(),
    ...projectMethods(),
    ...usageMethods(),
  }
}
