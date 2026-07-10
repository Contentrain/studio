/**
 * Plain-Postgres DatabaseProvider — COMPLETE.
 *
 * Every module was ported against the contract suite (tests/contract),
 * which runs the specs the Supabase implementation's behavior defines,
 * against a real Postgres. The `DatabaseProvider` return type below is the
 * compile-time completeness proof: a missing method fails typecheck.
 *
 * NOT yet wired into the factory: the postgres pair only becomes selectable
 * together with the managed AuthProvider (the accessToken-bearing methods
 * verify managed-auth JWTs — Supabase-issued tokens won't resolve an RLS
 * subject here). server/utils/providers.ts and the boot guard in
 * 00.validate-config.ts flip in the managed-auth phase.
 */
import type { DatabaseProvider } from '../database'
import { auditMethods } from './audit'
import { cdnMethods } from './cdn'
import { conversationMethods } from './conversations'
import { formMethods } from './forms'
import { mcpCloudMethods } from './mcp-cloud'
import { mediaMethods } from './media'
import { memberMethods } from './members'
import { oauthTokenMethods } from './oauth-tokens'
import { paymentAccountMethods } from './payment-accounts'
import { profileMethods } from './profiles'
import { projectMethods } from './projects'
import { trialReminderMethods } from './trial-reminders'
import { usageMethods } from './usage'
import { webhookMethods } from './webhooks'
import { workspaceMethods } from './workspaces'

export { closePostgresDb, configurePostgresDb, getPostgresConfig } from './client'
export type { PostgresDbConfig } from './client'

export function createPostgresDatabaseProvider(): DatabaseProvider {
  return {
    ...profileMethods(),
    ...oauthTokenMethods(),
    ...auditMethods(),
    ...trialReminderMethods(),
    ...workspaceMethods(),
    ...memberMethods(),
    ...projectMethods(),
    ...usageMethods(),
    ...conversationMethods(),
    ...cdnMethods(),
    ...mcpCloudMethods(),
    ...mediaMethods(),
    ...formMethods(),
    ...webhookMethods(),
    ...paymentAccountMethods(),
  }
}
