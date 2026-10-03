/**
 * Migrate grant persistence for the Supabase DatabaseProvider.
 *
 * `migrate_grants` is service-role only (RLS on, no policies), so every
 * query uses the admin client. See migration 031 for the lifecycle.
 */
import type { DatabaseProvider, DatabaseRow, MigrateCommentsExportRow } from '../database'
import { getAdmin } from './helpers'

type MigrateGrantMethods = Pick<
  DatabaseProvider,
  | 'claimMigrateGrant'
  | 'getMigrateGrantByOrderId'
  | 'getMigrateGrantForUser'
  | 'bindMigrateGrantWorkspace'
  | 'markMigrateGrantRedeemed'
  | 'getMigrateGrantOrigin'
  | 'claimMigrateS2sJti'
  | 'listOwnedWorkspacesAdmin'
  | 'saveMigrateCommentsExport'
  | 'getMigrateCommentsExport'
  | 'getMigrateCommentsExportState'
  | 'markMigrateCommentsExportImported'
>

function fail(message: string): never {
  throw createError({ statusCode: 500, message })
}

type ExportRow = { grant_id: string, status: string, comments: number, expires_at: string, imported_at: string | null, payload?: unknown }

function exportView(row: ExportRow, withPayload: boolean): MigrateCommentsExportRow {
  return {
    grantId: row.grant_id,
    status: row.status as MigrateCommentsExportRow['status'],
    comments: row.comments,
    expiresAt: new Date(row.expires_at).toISOString(),
    importedAt: row.imported_at ? new Date(row.imported_at).toISOString() : null,
    ...(withPayload ? { payload: row.payload ?? null } : {}),
  }
}

/** The table is missing: Postgres `undefined_table`, or PostgREST's schema-cache miss. */
const MISSING_RELATION_CODES = ['42P01', 'PGRST205']

/** Exports never imported within their window give up their payload (lazy cleanup). */
async function expireCommentExports(): Promise<void> {
  const { error } = await getAdmin()
    .from('migrate_comment_exports')
    .update({ status: 'expired', payload: null })
    .not('payload', 'is', null)
    .lt('expires_at', new Date().toISOString())
  if (error) fail(error.message)
}

function isMissingRelation(error: { code?: string } | null): boolean {
  return !!error?.code && MISSING_RELATION_CODES.includes(error.code)
}

/** Only the missing table reads as "no export", so a claim still answers while 040 is pending. */
function warnMissingRelation(code: string | undefined): void {
  // eslint-disable-next-line no-console -- ops visibility: the migration is pending
  console.warn(`[migrate-comments] ${code}: migrate_comment_exports is missing; apply migration 040`)
}

const EXPORT_COLUMNS = 'grant_id, status, comments, expires_at, imported_at'

export function migrateGrantMethods(): MigrateGrantMethods {
  return {
    async claimMigrateS2sJti(jti, purpose, expiresAt) {
      const admin = getAdmin()
      const { error: cleanupError } = await admin.from('migrate_s2s_jti').delete().lt('expires_at', new Date().toISOString())
      if (cleanupError) fail(cleanupError.message)
      const { data, error } = await admin
        .from('migrate_s2s_jti')
        .upsert({ jti, purpose, expires_at: expiresAt.toISOString() }, { onConflict: 'jti', ignoreDuplicates: true })
        .select('jti')
      if (error) fail(error.message)
      return (data?.length ?? 0) > 0
    },

    async listOwnedWorkspacesAdmin(userId) {
      const { data, error } = await getAdmin()
        .from('workspaces')
        .select('id, type, plan, overage_settings')
        .eq('owner_id', userId)
      if (error) fail(error.message)
      return (data ?? []) as DatabaseRow[]
    },

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

    async getMigrateGrantByOrderId(orderId) {
      const { data, error } = await getAdmin()
        .from('migrate_grants')
        .select('*')
        .eq('order_id', orderId)
        .maybeSingle()
      if (error) fail(error.message)
      return (data as DatabaseRow | null) ?? null
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

    async saveMigrateCommentsExport(grantId, input) {
      const admin = getAdmin()
      const values = {
        status: input.status,
        payload: input.status === 'ready' ? input.payload : null,
        comments: input.comments,
        expires_at: input.expiresAt,
        fetched_at: new Date().toISOString(),
      }
      // Replace any row but an imported one (final); insert when there is none.
      const { data: updated, error } = await admin
        .from('migrate_comment_exports')
        .update(values)
        .eq('grant_id', grantId)
        .neq('status', 'imported')
        .select('grant_id')
      if (error) fail(error.message)
      if (updated && updated.length > 0) return
      const { error: insertError } = await admin
        .from('migrate_comment_exports')
        .upsert({ grant_id: grantId, ...values }, { onConflict: 'grant_id', ignoreDuplicates: true })
      if (insertError) fail(insertError.message)
    },

    async getMigrateCommentsExport(workspaceId, repoFullName, options = {}) {
      const [owner, name] = repoFullName.split('/')
      if (!owner || !name) return null
      await expireCommentExports()
      const { data, error } = await getAdmin()
        .from('migrate_comment_exports')
        .select(`${EXPORT_COLUMNS}${options.withPayload ? ', payload' : ''}, migrate_grants!inner(workspace_id, repo_owner, repo_name, created_at)`)
        .eq('migrate_grants.workspace_id', workspaceId)
        .ilike('migrate_grants.repo_owner', owner.replace(/[\\%_]/g, '\\$&'))
        .ilike('migrate_grants.repo_name', name.replace(/[\\%_]/g, '\\$&'))
      if (error) fail(error.message)
      const rows = ((data ?? []) as unknown as Array<ExportRow & { migrate_grants: { created_at: string } }>)
        .sort((a, b) => Date.parse(b.migrate_grants.created_at) - Date.parse(a.migrate_grants.created_at))
      return rows[0] ? exportView(rows[0], options.withPayload === true) : null
    },

    async getMigrateCommentsExportState(grantId) {
      const { error: expireError } = await getAdmin()
        .from('migrate_comment_exports')
        .update({ status: 'expired', payload: null })
        .not('payload', 'is', null)
        .lt('expires_at', new Date().toISOString())
      if (expireError) {
        if (isMissingRelation(expireError)) {
          warnMissingRelation(expireError.code)
          return null
        }
        fail(expireError.message)
      }
      const { data, error } = await getAdmin()
        .from('migrate_comment_exports')
        .select(EXPORT_COLUMNS)
        .eq('grant_id', grantId)
        .maybeSingle()
      if (error) {
        if (isMissingRelation(error)) {
          warnMissingRelation(error.code)
          return null
        }
        fail(error.message)
      }
      return data ? exportView(data as ExportRow, false) : null
    },

    async markMigrateCommentsExportImported(grantId) {
      const { error } = await getAdmin()
        .from('migrate_comment_exports')
        .update({ status: 'imported', payload: null, imported_at: new Date().toISOString() })
        .eq('grant_id', grantId)
        .eq('status', 'ready')
      if (error) fail(error.message)
    },
  }
}
