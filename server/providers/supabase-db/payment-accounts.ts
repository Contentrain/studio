/**
 * Payment account + usage outbox persistence for the Supabase DatabaseProvider.
 *
 * `payment_accounts` stores per-provider subscription state with at most
 * one active row per workspace (`idx_payment_accounts_one_active` unique
 * partial index). `usage_events_outbox` buffers meter events for later
 * ingestion by the active payment plugin.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type PaymentAccountMethods = Pick<
  DatabaseProvider,
  | 'getActivePaymentAccount'
  | 'upsertPaymentAccount'
  | 'archiveActivePaymentAccount'
  | 'enqueueUsageEvent'
  | 'listPendingUsageEvents'
  | 'markUsageEventIngested'
>

export function paymentAccountMethods(): PaymentAccountMethods {
  return {
    async getActivePaymentAccount(workspaceId) {
      const { data, error } = await getAdmin()
        .from('payment_accounts')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('is_active', true)
        .maybeSingle()

      if (error && error.code !== 'PGRST116') {
        throw createError({ statusCode: 500, message: error.message })
      }
      return (data ?? null) as DatabaseRow | null
    },

    async upsertPaymentAccount(input) {
      const admin = getAdmin()
      const nowActive = input.isActive ?? true

      // If this row is intended to be active, archive any competing active row first.
      if (nowActive) {
        const { error: archiveError } = await admin
          .from('payment_accounts')
          .update({ is_active: false, archived_at: new Date().toISOString() })
          .eq('workspace_id', input.workspaceId)
          .eq('is_active', true)
          .not('provider', 'eq', input.provider)

        if (archiveError) {
          throw createError({ statusCode: 500, message: `Failed to archive prior payment account: ${archiveError.message}` })
        }
      }

      const payload: Record<string, unknown> = {
        workspace_id: input.workspaceId,
        provider: input.provider,
        customer_id: input.customerId,
        subscription_id: input.subscriptionId ?? null,
        subscription_status: input.subscriptionStatus ?? null,
        current_period_end: input.currentPeriodEnd ?? null,
        trial_ends_at: input.trialEndsAt ?? null,
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
        grace_period_ends_at: input.gracePeriodEndsAt ?? null,
        plan: input.plan ?? null,
        plugin_metadata: input.pluginMetadata ?? {},
        is_active: nowActive,
      }
      if (!nowActive) payload.archived_at = new Date().toISOString()

      const { data, error } = await admin
        .from('payment_accounts')
        .upsert(payload, { onConflict: 'workspace_id,provider,customer_id' })
        .select()
        .single()

      if (error) {
        throw createError({ statusCode: 500, message: `Failed to upsert payment account: ${error.message}` })
      }
      return data as DatabaseRow
    },

    async archiveActivePaymentAccount(workspaceId) {
      const { error } = await getAdmin()
        .from('payment_accounts')
        .update({ is_active: false, archived_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
        .eq('is_active', true)

      if (error) {
        throw createError({ statusCode: 500, message: `Failed to archive payment account: ${error.message}` })
      }
    },

    async enqueueUsageEvent(input) {
      const payload = {
        workspace_id: input.workspaceId,
        meter_name: input.meterName,
        value: input.value,
        occurred_at: input.occurredAt ?? new Date().toISOString(),
        idempotency_key: input.idempotencyKey,
        metadata: input.metadata ?? {},
      }

      const { error } = await getAdmin()
        .from('usage_events_outbox')
        .insert(payload)

      if (error) {
        // Unique-constraint violation on (workspace_id, idempotency_key) is expected
        // on retries — silently swallow it. Anything else is a real problem.
        if (error.code === '23505') return
        throw createError({ statusCode: 500, message: `Failed to enqueue usage event: ${error.message}` })
      }
    },

    async listPendingUsageEvents(limit) {
      const { data, error } = await getAdmin()
        .from('usage_events_outbox')
        .select('*')
        .is('ingested_at', null)
        .order('occurred_at', { ascending: true })
        .limit(limit)

      if (error) {
        throw createError({ statusCode: 500, message: `Failed to list pending usage events: ${error.message}` })
      }
      return (data ?? []) as DatabaseRow[]
    },

    async markUsageEventIngested(id, errorMessage) {
      const admin = getAdmin()

      if (errorMessage) {
        const { data, error } = await admin
          .from('usage_events_outbox')
          .select('attempt_count')
          .eq('id', id)
          .single()

        if (error) {
          throw createError({ statusCode: 500, message: `Failed to read usage event: ${error.message}` })
        }

        const prev = (data?.attempt_count as number | undefined) ?? 0
        const { error: updateError } = await admin
          .from('usage_events_outbox')
          .update({
            attempt_count: prev + 1,
            last_error: errorMessage,
          })
          .eq('id', id)

        if (updateError) {
          throw createError({ statusCode: 500, message: `Failed to record usage event failure: ${updateError.message}` })
        }
        return
      }

      const { error } = await admin
        .from('usage_events_outbox')
        .update({
          ingested_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', id)

      if (error) {
        throw createError({ statusCode: 500, message: `Failed to mark usage event ingested: ${error.message}` })
      }
    },
  }
}
