/**
 * Migrate grant persistence for the plain-Postgres DatabaseProvider.
 *
 * `migrate_grants` is service-role only (RLS on, no policies), so every
 * query runs on the admin connection. See migration 031 for the lifecycle.
 */
import type { DatabaseProvider, DatabaseRow, MigrateCommentsExportRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

type MigrateGrantMethods = Pick<
  DatabaseProvider,
  | 'claimMigrateGrant'
  | 'getMigrateGrantForUser'
  | 'bindMigrateGrantWorkspace'
  | 'markMigrateGrantRedeemed'
  | 'getMigrateGrantOrigin'
  | 'saveMigrateCommentsExport'
  | 'getMigrateCommentsExport'
  | 'getMigrateCommentsExportState'
  | 'markMigrateCommentsExportImported'
>

type ExportRow = { grant_id: string, status: string, comments: number, expires_at: unknown, imported_at: unknown, payload?: unknown }

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value))

function exportView(row: ExportRow, withPayload: boolean): MigrateCommentsExportRow {
  return {
    grantId: row.grant_id,
    status: row.status as MigrateCommentsExportRow['status'],
    comments: row.comments,
    expiresAt: iso(row.expires_at),
    importedAt: row.imported_at == null ? null : iso(row.imported_at),
    ...(withPayload ? { payload: row.payload ?? null } : {}),
  }
}

/** Exports never imported within their window give up their payload (lazy cleanup). */
async function expireCommentExports(): Promise<void> {
  await getAdmin()
    .updateTable('migrate_comment_exports')
    .set({ status: 'expired', payload: null })
    .where('payload', 'is not', null)
    .where('expires_at', '<', new Date().toISOString())
    .execute()
}

/** Postgres' `undefined_table`: the image is newer than the database (migration 040 not applied). */
const UNDEFINED_TABLE = '42P01'

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

    async saveMigrateCommentsExport(grantId, input) {
      try {
        const values = {
          status: input.status,
          payload: input.status === 'ready' ? JSON.stringify(input.payload) : null,
          comments: input.comments,
          expires_at: input.expiresAt,
        }
        await getAdmin()
          .insertInto('migrate_comment_exports')
          .values({ grant_id: grantId, ...values })
          .onConflict(oc => oc.column('grant_id')
            .doUpdateSet({ ...values, fetched_at: new Date().toISOString() })
            // An imported export is final.
            .where('migrate_comment_exports.status', '<>', 'imported'))
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getMigrateCommentsExport(workspaceId, repoFullName, options = {}) {
      const [owner, name] = repoFullName.toLowerCase().split('/')
      if (!owner || !name) return null
      try {
        await expireCommentExports()
        const row = await getAdmin()
          .selectFrom('migrate_comment_exports as e')
          .innerJoin('migrate_grants as g', 'g.id', 'e.grant_id')
          .select(['e.grant_id', 'e.status', 'e.comments', 'e.expires_at', 'e.imported_at'])
          .$if(options.withPayload === true, qb => qb.select('e.payload'))
          .where('g.workspace_id', '=', workspaceId)
          .where(eb => eb.fn('lower', ['g.repo_owner']), '=', owner)
          .where(eb => eb.fn('lower', ['g.repo_name']), '=', name)
          .orderBy('g.created_at', 'desc')
          .limit(1)
          .executeTakeFirst()
        return row ? exportView(row as ExportRow, options.withPayload === true) : null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getMigrateCommentsExportState(grantId) {
      try {
        await expireCommentExports()
        const row = await getAdmin()
          .selectFrom('migrate_comment_exports')
          .select(['grant_id', 'status', 'comments', 'expires_at', 'imported_at'])
          .where('grant_id', '=', grantId)
          .executeTakeFirst()
        return row ? exportView(row as ExportRow, false) : null
      }
      catch (error) {
        // Only the missing table reads as "no export", so a claim still answers
        // while 040 is pending; every other failure surfaces.
        if ((error as { code?: string } | null)?.code === UNDEFINED_TABLE) {
          // eslint-disable-next-line no-console -- ops visibility: the migration is pending
          console.warn(`[migrate-comments] ${UNDEFINED_TABLE}: migrate_comment_exports is missing; apply migration 040`)
          return null
        }
        throwDbError(error)
      }
    },

    async markMigrateCommentsExportImported(grantId) {
      try {
        await getAdmin()
          .updateTable('migrate_comment_exports')
          .set({ status: 'imported', payload: null, imported_at: new Date().toISOString() })
          .where('grant_id', '=', grantId)
          .where('status', '=', 'ready')
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
