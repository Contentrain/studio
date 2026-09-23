/**
 * Payment account + usage outbox persistence for the plain-Postgres
 * DatabaseProvider.
 *
 * Behavior parity with supabase-db/payment-accounts.ts, with one deliberate
 * upgrade: upsertPaymentAccount archives the competing active row and
 * upserts the new one in a SINGLE transaction — the PostgREST impl's
 * two-call sequence could leave a workspace with no active payment account
 * if the upsert failed after the archive.
 */
import { sql } from 'kysely'
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

type PaymentAccountMethods = Pick<
  DatabaseProvider,
  | 'getActivePaymentAccount'
  | 'upsertPaymentAccount'
  | 'setPaymentAccountMetadataKey'
  | 'archiveActivePaymentAccount'
  | 'enqueueUsageEvent'
  | 'listPendingUsageEvents'
  | 'markUsageEventIngested'
  | 'markUsageEventDropped'
>

/**
 * `plugin_metadata` for the ON CONFLICT update: the new value, except that
 * the preserved keys keep what the row holds at write time (the conflict
 * update sees the latest committed row, so a concurrent claim survives).
 */
function metadataOnUpdate(next: string, preserve: string[] | undefined) {
  if (!preserve?.length) return next
  return sql`(${next}::jsonb - ${preserve}::text[]) || coalesce(
    (SELECT jsonb_object_agg(e.key, e.value)
       FROM jsonb_each(payment_accounts.plugin_metadata) AS e
      WHERE e.key = ANY(${preserve}::text[])),
    '{}'::jsonb)`
}

export function paymentAccountMethods(): PaymentAccountMethods {
  return {
    async getActivePaymentAccount(workspaceId) {
      try {
        const row = await getAdmin()
          .selectFrom('payment_accounts')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .where('is_active', '=', true)
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async upsertPaymentAccount(input) {
      const nowActive = input.isActive ?? true

      const payload = {
        workspace_id: input.workspaceId,
        provider: input.provider,
        customer_id: input.customerId,
        subscription_id: input.subscriptionId ?? null,
        subscription_status: input.subscriptionStatus ?? null,
        current_period_start: input.currentPeriodStart ?? null,
        current_period_end: input.currentPeriodEnd ?? null,
        trial_ends_at: input.trialEndsAt ?? null,
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
        grace_period_ends_at: input.gracePeriodEndsAt ?? null,
        plan: input.plan ?? null,
        plugin_metadata: JSON.stringify(input.pluginMetadata ?? {}),
        is_active: nowActive,
        ...(nowActive ? {} : { archived_at: new Date().toISOString() }),
      }

      try {
        return await getAdmin().transaction().execute(async (trx) => {
          // Archive any competing active row first — atomically with the
          // upsert, so a failure can never leave the workspace accountless.
          if (nowActive) {
            await trx
              .updateTable('payment_accounts')
              .set({ is_active: false, archived_at: new Date().toISOString() })
              .where('workspace_id', '=', input.workspaceId)
              .where('is_active', '=', true)
              .where('provider', '!=', input.provider)
              .execute()
          }

          const row = await trx
            .insertInto('payment_accounts')
            .values(payload as never)
            .onConflict(oc => oc
              .columns(['workspace_id', 'provider', 'customer_id'])
              .doUpdateSet({
                subscription_id: payload.subscription_id,
                subscription_status: payload.subscription_status,
                current_period_start: payload.current_period_start,
                current_period_end: payload.current_period_end,
                trial_ends_at: payload.trial_ends_at,
                cancel_at_period_end: payload.cancel_at_period_end,
                grace_period_ends_at: payload.grace_period_ends_at,
                plan: payload.plan,
                ...(input.pluginMetadata === undefined ? {} : { plugin_metadata: metadataOnUpdate(payload.plugin_metadata, input.preserveMetadataKeys) }),
                is_active: payload.is_active,
                ...(nowActive ? { archived_at: null } : { archived_at: new Date().toISOString() }),
              } as never))
            .returningAll()
            .executeTakeFirst()

          if (!row)
            throw createError({ statusCode: 500, message: 'Failed to upsert payment account: empty response' })

          return row as DatabaseRow
        })
      }
      catch (error) {
        if (error && typeof error === 'object' && 'statusCode' in error) throw error
        throw createError({
          statusCode: 500,
          message: `Failed to upsert payment account: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async setPaymentAccountMetadataKey({ workspaceId, key, value, when }) {
      // One statement: the row lock makes a concurrent caller re-check the
      // condition against this write, so only one of them changes the row.
      const condition = when === 'absent'
        ? sql`(coalesce(plugin_metadata, '{}'::jsonb) -> ${key}::text) IS NULL`
        : when === 'different'
          ? sql`(plugin_metadata ->> ${key}::text) IS DISTINCT FROM ${value}::text`
          : sql`(plugin_metadata ->> ${key}::text) = ${when.equals}::text`
      try {
        const result = await sql<{ id: string }>`
          UPDATE payment_accounts
          SET plugin_metadata = coalesce(plugin_metadata, '{}'::jsonb) || jsonb_build_object(${key}::text, ${value}::text)
          WHERE workspace_id = ${workspaceId} AND is_active = true AND ${condition}
          RETURNING id
        `.execute(getAdmin())
        return result.rows.length > 0
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async archiveActivePaymentAccount(workspaceId) {
      try {
        await getAdmin()
          .updateTable('payment_accounts')
          .set({ is_active: false, archived_at: new Date().toISOString() })
          .where('workspace_id', '=', workspaceId)
          .where('is_active', '=', true)
          .execute()
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Failed to archive payment account: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async enqueueUsageEvent(input) {
      try {
        await getAdmin()
          .insertInto('usage_events_outbox')
          .values({
            workspace_id: input.workspaceId,
            meter_name: input.meterName,
            value: input.value,
            occurred_at: input.occurredAt ?? new Date().toISOString(),
            idempotency_key: input.idempotencyKey,
            metadata: JSON.stringify(input.metadata ?? {}),
          })
          .execute()
      }
      catch (error) {
        // Unique-constraint violation on (workspace_id, idempotency_key) is
        // expected on retries — silently swallow it.
        if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') return
        throw createError({
          statusCode: 500,
          message: `Failed to enqueue usage event: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async listPendingUsageEvents(limit) {
      try {
        return await getAdmin()
          .selectFrom('usage_events_outbox')
          .selectAll()
          .where('ingested_at', 'is', null)
          .orderBy('occurred_at', 'asc')
          .limit(limit)
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Failed to list pending usage events: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async markUsageEventIngested(id, errorMessageText) {
      try {
        if (errorMessageText) {
          // Single atomic statement (the PostgREST impl needed a read-then-
          // write because it can't express attempt_count = attempt_count + 1).
          const rows = await getAdmin()
            .updateTable('usage_events_outbox')
            .set({
              attempt_count: sql`attempt_count + 1`,
              last_error: errorMessageText,
            })
            .where('id', '=', id)
            .returning('id')
            .execute()

          if (rows.length === 0)
            throw createError({ statusCode: 500, message: 'Failed to read usage event: row not found' })

          return
        }

        await getAdmin()
          .updateTable('usage_events_outbox')
          .set({ ingested_at: new Date().toISOString(), last_error: null })
          .where('id', '=', id)
          .execute()
      }
      catch (error) {
        if (error && typeof error === 'object' && 'statusCode' in error) throw error
        throw createError({
          statusCode: 500,
          message: `Failed to mark usage event ingested: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async markUsageEventDropped(id, reason) {
      try {
        await getAdmin()
          .updateTable('usage_events_outbox')
          .set({
            ingested_at: new Date().toISOString(),
            attempt_count: sql`attempt_count + 1`,
            last_error: reason,
          })
          .where('id', '=', id)
          .execute()
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Failed to drop usage event: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },
  }
}
