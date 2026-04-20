/**
 * Trial reminder persistence methods for the Supabase DatabaseProvider.
 *
 * Only two operations are needed — the cron in
 * `server/plugins/trial-reminder.ts` lists workspaces that still owe a
 * reminder in the sequence, dispatches an email per match, and bumps
 * the stage. `workspaces.trial_reminder_stage` is monotonic so the
 * cron stays idempotent across restarts or overlapping runs.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type TrialReminderMethods = Pick<
  DatabaseProvider,
  | 'listWorkspacesPendingTrialReminder'
  | 'setTrialReminderStage'
>

export function trialReminderMethods(): TrialReminderMethods {
  return {
    async listWorkspacesPendingTrialReminder({ from, to, requiredStage }) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('workspaces')
        .select('id, name, slug, plan, owner_id, trial_ends_at, trial_reminder_stage')
        .eq('subscription_status', 'trialing')
        .gte('trial_ends_at', from)
        .lte('trial_ends_at', to)
        .lt('trial_reminder_stage', requiredStage)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []) as unknown as DatabaseRow[]
    },

    async setTrialReminderStage(workspaceId, stage) {
      const admin = getAdmin()
      const { error } = await admin
        .from('workspaces')
        .update({ trial_reminder_stage: stage })
        .eq('id', workspaceId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },
  }
}
