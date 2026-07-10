import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { trialReminderMethods } from '../../server/providers/postgres-db/trial-reminders'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db trial-reminders (contract)', () => {
  const methods = trialReminderMethods()
  let pending: SeededUser
  let alreadyReminded: SeededUser
  let notTrialing: SeededUser

  const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const to = new Date(Date.now() + 72 * 3600 * 1000).toISOString()
  const trialEnd = new Date(Date.now() + 48 * 3600 * 1000).toISOString()

  async function seedPaymentAccount(workspaceId: string, subscriptionStatus: string) {
    await sql`
      INSERT INTO public.payment_accounts (workspace_id, provider, customer_id, subscription_status, trial_ends_at, is_active)
      VALUES (${workspaceId}, 'polar', ${`cus_${workspaceId.slice(0, 8)}`}, ${subscriptionStatus}, ${trialEnd}, true)
    `.execute(getDb())
  }

  beforeAll(async () => {
    pending = await seedUser('trial-pending')
    alreadyReminded = await seedUser('trial-done')
    notTrialing = await seedUser('trial-active')

    await seedPaymentAccount(pending.workspaceId, 'trialing')
    await seedPaymentAccount(alreadyReminded.workspaceId, 'trialing')
    await seedPaymentAccount(notTrialing.workspaceId, 'active')

    await methods.setTrialReminderStage(alreadyReminded.workspaceId, 2)
  })

  afterAll(async () => {
    for (const user of [pending, alreadyReminded, notTrialing])
      await deleteSeededUser(user.userId) // payment_accounts cascade via workspace
  })

  it('lists only active trialing workspaces below the required stage', async () => {
    const rows = await methods.listWorkspacesPendingTrialReminder({ from, to, requiredStage: 1 })
    const ids = rows.map(r => r.id)

    expect(ids).toContain(pending.workspaceId)
    expect(ids).not.toContain(alreadyReminded.workspaceId) // stage 2 ≥ 1
    expect(ids).not.toContain(notTrialing.workspaceId) // status active

    const row = rows.find(r => r.id === pending.workspaceId)!
    expect(Object.keys(row).sort()).toEqual(
      ['id', 'name', 'owner_id', 'plan', 'slug', 'trial_ends_at', 'trial_reminder_stage'],
    )
    expect(row.trial_reminder_stage).toBe(0)
    expect(Date.parse(row.trial_ends_at as string)).toBe(Date.parse(trialEnd))
  })

  it('respects the trial_ends_at window bounds', async () => {
    const past = await methods.listWorkspacesPendingTrialReminder({
      from: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      to: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
      requiredStage: 1,
    })

    expect(past.map(r => r.id)).not.toContain(pending.workspaceId)
  })

  it('setTrialReminderStage advances the cursor and drops the workspace from the pending list', async () => {
    await methods.setTrialReminderStage(pending.workspaceId, 1)

    const stage = await sql<{ trial_reminder_stage: number }>`
      SELECT trial_reminder_stage FROM public.workspaces WHERE id = ${pending.workspaceId}
    `.execute(getDb())
    expect(stage.rows[0]!.trial_reminder_stage).toBe(1)

    const rows = await methods.listWorkspacesPendingTrialReminder({ from, to, requiredStage: 1 })
    expect(rows.map(r => r.id)).not.toContain(pending.workspaceId)

    const nextStage = await methods.listWorkspacesPendingTrialReminder({ from, to, requiredStage: 2 })
    expect(nextStage.map(r => r.id)).toContain(pending.workspaceId)
  })
})
