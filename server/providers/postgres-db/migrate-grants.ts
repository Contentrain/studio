/**
 * Migrate grant persistence for the plain-Postgres DatabaseProvider.
 *
 * `migrate_grants` is service-role only (RLS on, no policies), so every
 * query runs on the admin connection. See migration 031 for the lifecycle.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

type MigrateGrantMethods = Pick<
  DatabaseProvider,
  | 'claimMigrateGrant'
  | 'getMigrateGrantForUser'
  | 'bindMigrateGrantWorkspace'
  | 'markMigrateGrantRedeemed'
  | 'getMigrateGrantOrigin'
>

export function migrateGrantMethods(): MigrateGrantMethods {
  return {
    async claimMigrateGrant(input) {
      try {
        const inserted = await getAdmin()
          .insertInto('migrate_grants')
          .values({
            order_id: input.orderId,
            claim_jti: input.claimJti,
            user_id: input.userId,
            plan: input.plan,
            trial_days: input.trialDays,
            repo_owner: input.repoOwner,
            repo_name: input.repoName,
            email: input.email,
            origin: input.origin ?? null,
          })
          .onConflict(oc => oc.column('order_id').doNothing())
          .returningAll()
          .executeTakeFirst()
        if (inserted) return { grant: inserted as DatabaseRow, created: true }

        // A grant recorded before claims carried an origin takes it now; one it has is never replaced.
        if (input.origin) {
          await getAdmin()
            .updateTable('migrate_grants')
            .set({ origin: input.origin })
            .where('order_id', '=', input.orderId)
            .where('origin', 'is', null)
            .execute()
        }
        const existing = await getAdmin()
          .selectFrom('migrate_grants')
          .selectAll()
          .where('order_id', '=', input.orderId)
          .executeTakeFirstOrThrow()
        return { grant: existing as DatabaseRow, created: false }
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getMigrateGrantForUser(grantId, userId) {
      try {
        const row = await getAdmin()
          .selectFrom('migrate_grants')
          .selectAll()
          .where('id', '=', grantId)
          .where('user_id', '=', userId)
          .executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async bindMigrateGrantWorkspace(grantId, workspaceId) {
      try {
        // Bind if never bound (atomic); a grant already bound to this
        // workspace matches unchanged — `bound_at` never moves forward.
        const row = await getAdmin()
          .updateTable('migrate_grants')
          .set(eb => ({
            workspace_id: workspaceId,
            bound_at: eb.fn.coalesce('bound_at', eb.fn<string>('now', [])),
          }))
          .where('id', '=', grantId)
          .where(eb => eb.or([
            eb('bound_at', 'is', null),
            eb('workspace_id', '=', workspaceId),
          ]))
          .returningAll()
          .executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async markMigrateGrantRedeemed(grantId, subscriptionId) {
      try {
        await getAdmin()
          .updateTable('migrate_grants')
          .set(eb => ({ redeemed_at: eb.fn<string>('now', []), redeemed_subscription_id: subscriptionId }))
          .where('id', '=', grantId)
          .where('redeemed_at', 'is', null)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getMigrateGrantOrigin(workspaceId, repoFullName) {
      const [owner, name] = repoFullName.toLowerCase().split('/')
      if (!owner || !name) return null
      try {
        const row = await getAdmin()
          .selectFrom('migrate_grants')
          .select('origin')
          .where('workspace_id', '=', workspaceId)
          .where(eb => eb.fn('lower', ['repo_owner']), '=', owner)
          .where(eb => eb.fn('lower', ['repo_name']), '=', name)
          .where('origin', 'is not', null)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst()
        return row?.origin ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
