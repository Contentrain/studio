/**
 * Trial reminder persistence methods for the Supabase DatabaseProvider.
 *
 * Trialing subscription state lives on `payment_accounts`; the monotonic
 * `trial_reminder_stage` counter stays on `workspaces` (it is a per-
 * workspace send cursor, not a per-subscription billing field). The
 * listing query joins the two so reminders fire off a single billing
 * source of truth.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type TrialReminderMethods = Pick<
  DatabaseProvider,
  | 'listWorkspacesPendingTrialReminder'
  | 'setTrialReminderStage'
>

interface WorkspaceRelation {
  id: string
  name: string | null
  slug: string | null
  plan: string | null
  owner_id: string | null
  trial_reminder_stage: number | null
}

export function trialReminderMethods(): TrialReminderMethods {
  return {
    async listWorkspacesPendingTrialReminder({ from, to, requiredStage }) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('payment_accounts')
        .select(`
          trial_ends_at,
          workspaces:workspace_id!inner(
            id, name, slug, plan, owner_id, trial_reminder_stage
          )
        `)
        .eq('is_active', true)
        .eq('subscription_status', 'trialing')
        .gte('trial_ends_at', from)
        .lte('trial_ends_at', to)

      if (error) throw createError({ statusCode: 500, message: error.message })

      const rows = ((data ?? []) as unknown as Array<{ trial_ends_at: string, workspaces: WorkspaceRelation }>)
        .filter(r => (r.workspaces.trial_reminder_stage ?? 0) < requiredStage)
        .map(r => ({
          id: r.workspaces.id,
          name: r.workspaces.name,
          slug: r.workspaces.slug,
          plan: r.workspaces.plan,
          owner_id: r.workspaces.owner_id,
          trial_reminder_stage: r.workspaces.trial_reminder_stage,
          trial_ends_at: r.trial_ends_at,
        }))

      return rows as unknown as DatabaseRow[]
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
