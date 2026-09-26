/**
 * Migrate grant persistence for the Supabase DatabaseProvider.
 *
 * `migrate_grants` is service-role only (RLS on, no policies), so every
 * query uses the admin client. See migration 031 for the lifecycle.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type MigrateGrantMethods = Pick<
  DatabaseProvider,
  | 'claimMigrateGrant'
  | 'getMigrateGrantForUser'
  | 'bindMigrateGrantWorkspace'
  | 'markMigrateGrantRedeemed'
  | 'getMigrateGrantOrigin'
>

function fail(message: string): never {
  throw createError({ statusCode: 500, message })
}

export function migrateGrantMethods(): MigrateGrantMethods {
  return {
    async claimMigrateGrant(input) {
      const admin = getAdmin()
      const { data: inserted, error } = await admin
        .from('migrate_grants')
        .upsert({
          order_id: input.orderId,
          claim_jti: input.claimJti,
          user_id: input.userId,
          plan: input.plan,
          trial_days: input.trialDays,
          repo_owner: input.repoOwner,
          repo_name: input.repoName,
          email: input.email,
          origin: input.origin ?? null,
        }, { onConflict: 'order_id', ignoreDuplicates: true })
        .select()
      if (error) fail(error.message)
      if (inserted && inserted.length > 0) return { grant: inserted[0] as DatabaseRow, created: true }

      // A grant recorded before claims carried an origin takes it now; one it has is never replaced.
      if (input.origin) {
        const { error: originError } = await admin
          .from('migrate_grants')
          .update({ origin: input.origin })
          .eq('order_id', input.orderId)
          .is('origin', null)
        if (originError) fail(originError.message)
      }

      const { data: existing, error: readError } = await admin
        .from('migrate_grants')
        .select('*')
        .eq('order_id', input.orderId)
        .single()
      if (readError) fail(readError.message)
      return { grant: existing as DatabaseRow, created: false }
    },

    async getMigrateGrantForUser(grantId, userId) {
      const { data, error } = await getAdmin()
        .from('migrate_grants')
        .select('*')
        .eq('id', grantId)
        .eq('user_id', userId)
        .maybeSingle()
      if (error) fail(error.message)
      return (data as DatabaseRow | null) ?? null
    },

    async bindMigrateGrantWorkspace(grantId, workspaceId) {
      const admin = getAdmin()
      // Bind if never bound — the filter makes this the atomic step.
      const { data: bound, error } = await admin
        .from('migrate_grants')
        .update({ workspace_id: workspaceId, bound_at: new Date().toISOString() })
        .eq('id', grantId)
        .is('bound_at', null)
        .select()
      if (error) fail(error.message)
      if (bound && bound.length > 0) return bound[0] as DatabaseRow

      // Already bound: fine only if to this workspace (bound_at unchanged).
      const { data: same, error: readError } = await admin
        .from('migrate_grants')
        .select('*')
        .eq('id', grantId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (readError) fail(readError.message)
      return (same as DatabaseRow | null) ?? null
    },

    async markMigrateGrantRedeemed(grantId, subscriptionId) {
      const { error } = await getAdmin()
        .from('migrate_grants')
        .update({ redeemed_at: new Date().toISOString(), redeemed_subscription_id: subscriptionId })
        .eq('id', grantId)
        .is('redeemed_at', null)
      if (error) fail(error.message)
    },

    async getMigrateGrantOrigin(workspaceId, repoFullName) {
      const [owner, name] = repoFullName.split('/')
      if (!owner || !name) return null
      const { data, error } = await getAdmin()
        .from('migrate_grants')
        .select('origin')
        .eq('workspace_id', workspaceId)
        .ilike('repo_owner', owner.replace(/[\\%_]/g, '\\$&'))
        .ilike('repo_name', name.replace(/[\\%_]/g, '\\$&'))
        .not('origin', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) fail(error.message)
      return (data?.origin as string | null | undefined) ?? null
    },
  }
}
