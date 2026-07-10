/**
 * Trial reminder persistence methods for the plain-Postgres DatabaseProvider.
 *
 * Same shape as the Supabase implementation: trialing subscription state
 * lives on `payment_accounts`; the monotonic `trial_reminder_stage` cursor
 * stays on `workspaces`. Here the stage filter moves into SQL (the Supabase
 * impl filters client-side after an !inner join).
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

type TrialReminderMethods = Pick<
  DatabaseProvider,
  | 'listWorkspacesPendingTrialReminder'
  | 'setTrialReminderStage'
>

export function trialReminderMethods(): TrialReminderMethods {
  return {
    async listWorkspacesPendingTrialReminder({ from, to, requiredStage }) {
      try {
        const rows = await getAdmin()
          .selectFrom('payment_accounts')
          .innerJoin('workspaces', 'workspaces.id', 'payment_accounts.workspace_id')
          .select([
            'workspaces.id',
            'workspaces.name',
            'workspaces.slug',
            'workspaces.plan',
            'workspaces.owner_id',
            'workspaces.trial_reminder_stage',
            'payment_accounts.trial_ends_at',
          ])
          .where('payment_accounts.is_active', '=', true)
          .where('payment_accounts.subscription_status', '=', 'trialing')
          .where('payment_accounts.trial_ends_at', '>=', from)
          .where('payment_accounts.trial_ends_at', '<=', to)
          .where('workspaces.trial_reminder_stage', '<', requiredStage)
          .execute()

        return rows as unknown as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async setTrialReminderStage(workspaceId, stage) {
      try {
        await getAdmin()
          .updateTable('workspaces')
          .set({ trial_reminder_stage: stage })
          .where('id', '=', workspaceId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
