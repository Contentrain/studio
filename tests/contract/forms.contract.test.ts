import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formMethods } from '../../server/providers/postgres-db/forms'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db forms (contract)', () => {
  const methods = formMethods()
  let user: SeededUser
  let projectId: string
  const modelId = 'contact-form'

  beforeAll(async () => {
    user = await seedUser('forms')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/forms-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('submission lifecycle: create → get → approve (stamps) → delete', async () => {
    const created = await methods.createFormSubmission({
      project_id: projectId,
      workspace_id: user.workspaceId,
      model_id: modelId,
      data: { name: 'Ada', message: 'Hello' },
      source_ip: '198.51.100.7',
      user_agent: 'contract-suite',
    })
    expect(created.status).toBe('pending')
    expect(created.data).toEqual({ name: 'Ada', message: 'Hello' })

    const fetched = await methods.getFormSubmission(created.id as string)
    expect(fetched!.locale).toBe('en')

    const approved = await methods.updateFormSubmissionStatus(created.id as string, 'approved', user.userId, 'entry-9')
    expect(approved.status).toBe('approved')
    expect(approved.approved_by).toBe(user.userId)
    expect(approved.entry_id).toBe('entry-9')
    expect(approved.approved_at).not.toBeNull()

    await methods.deleteFormSubmission(created.id as string)
    expect(await methods.getFormSubmission(created.id as string)).toBeNull()
  })

  it('listing: status filter, sort, pagination, capped limit; monthly count', async () => {
    for (let i = 0; i < 3; i++) {
      await methods.createFormSubmission({
        project_id: projectId,
        workspace_id: user.workspaceId,
        model_id: modelId,
        data: { i },
        created_at: new Date(Date.now() + i * 1000).toISOString(),
      })
    }

    const all = await methods.listFormSubmissions(user.workspaceId, projectId, modelId)
    expect(all.total).toBe(3)
    expect((all.submissions[0]!.data as { i: number }).i).toBe(2) // newest first

    const oldest = await methods.listFormSubmissions(user.workspaceId, projectId, modelId, { sort: 'oldest', limit: 1 })
    expect((oldest.submissions[0]!.data as { i: number }).i).toBe(0)
    expect(oldest.total).toBe(3)

    const pending = await methods.listFormSubmissions(user.workspaceId, projectId, modelId, { status: 'pending' })
    expect(pending.total).toBe(3)

    expect(await methods.countMonthlySubmissions(user.workspaceId)).toBe(3)
  })

  it('bulkUpdateSubmissions honors scope filters and reports the touched count', async () => {
    const list = await methods.listFormSubmissions(user.workspaceId, projectId, modelId)
    const ids = list.submissions.map(s => s.id as string)

    const wrongScope = await methods.bulkUpdateSubmissions(ids, 'spam', undefined, { projectId: randomUUID() })
    expect(wrongScope).toBe(0)

    const updated = await methods.bulkUpdateSubmissions(ids.slice(0, 2), 'approved', user.userId, { workspaceId: user.workspaceId, projectId, modelId })
    expect(updated).toBe(2)

    const approved = await methods.listFormSubmissions(user.workspaceId, projectId, modelId, { status: 'approved' })
    expect(approved.total).toBe(2)
    expect(approved.submissions.every(s => s.approved_at !== null)).toBe(true)
  })

  it('createFormSubmissionIfAllowed enforces the monthly cap atomically', async () => {
    const current = await methods.countMonthlySubmissions(user.workspaceId)

    const grant = await methods.createFormSubmissionIfAllowed(user.workspaceId, current + 1, {
      project_id: projectId,
      model_id: modelId,
      data: { via: 'rpc' },
      locale: 'tr',
    })
    expect(grant.allowed).toBe(true)
    expect(grant.submission).toBeDefined()
    expect((grant.submission!.data as { via: string }).via).toBe('rpc')

    const denied = await methods.createFormSubmissionIfAllowed(user.workspaceId, current + 1, {
      project_id: projectId,
      model_id: modelId,
      data: { via: 'rpc-2' },
    })
    expect(denied.allowed).toBe(false)
    expect(denied.currentCount).toBe(current + 1)
  })

  it('counts and caps submissions over a billing window instead of the calendar month', async () => {
    const owner = await seedUser('forms-window')
    try {
      const project = await sql<{ id: string }>`
        INSERT INTO public.projects (workspace_id, repo_full_name)
        VALUES (${owner.workspaceId}, 'contentrain/forms-window-fixture') RETURNING id
      `.execute(getDb())
      const pid = project.rows[0]!.id
      // Two inside the slice, one just before it, one after it. All rows are ordinary submissions.
      for (const at of ['2026-02-10T10:00:00Z', '2026-02-20T10:00:00Z', '2026-02-02T10:00:00Z', '2026-03-12T10:00:00Z']) {
        await sql`
          INSERT INTO public.form_submissions (project_id, workspace_id, model_id, data, created_at)
          VALUES (${pid}, ${owner.workspaceId}, ${modelId}, '{}'::jsonb, ${at})
        `.execute(getDb())
      }
      const window = { from: '2026-02-05T00:00:00.000Z', to: '2026-03-05T00:00:00.000Z' }
      expect(await methods.countMonthlySubmissions(owner.workspaceId, window)).toBe(2)
      expect(await methods.countMonthlySubmissionsForModel(owner.workspaceId, pid, modelId, window)).toBe(2)

      const submission = { project_id: pid, model_id: modelId, data: { via: 'window' } }
      // The cap is counted over the window: 2 in it, so a limit of 2 is full...
      const denied = await methods.createFormSubmissionIfAllowed(owner.workspaceId, 2, submission, window)
      expect(denied).toMatchObject({ allowed: false, currentCount: 2 })
      // ...and one more fits under 3. The row it writes (now) is outside this past window, as it should be:
      // the window is the caller's to choose, the function only counts inside it.
      const granted = await methods.createFormSubmissionIfAllowed(owner.workspaceId, 3, submission, window)
      expect(granted).toMatchObject({ allowed: true, currentCount: 3 })
    }
    finally {
      await deleteSeededUser(owner.userId)
    }
  })

  it('per-model monthly count and notification recipients (owner + accepted admins with emails)', async () => {
    const before = await methods.countMonthlySubmissionsForModel(user.workspaceId, projectId, 'newsletter-signup')
    await methods.createFormSubmission({
      project_id: projectId,
      workspace_id: user.workspaceId,
      model_id: 'newsletter-signup',
      data: { email: 'sub@example.com' },
    })
    expect(await methods.countMonthlySubmissionsForModel(user.workspaceId, projectId, 'newsletter-signup')).toBe(before + 1)
    // Other models on the same workspace are not counted.
    expect(await methods.countMonthlySubmissionsForModel(user.workspaceId, projectId, 'no-such-model')).toBe(0)

    // Seeded owner comes back via workspaces.owner_id even without an explicit member row.
    const recipients = await methods.listWorkspaceNotificationRecipients(user.workspaceId)
    expect(recipients.map(r => r.userId)).toContain(user.userId)
    expect(recipients.find(r => r.userId === user.userId)?.email).toBe(user.email)

    // A pending (not accepted) admin invite is not a recipient.
    const invitee = await seedUser('forms-admin')
    await sql`
      INSERT INTO public.workspace_members (workspace_id, user_id, role, invited_email)
      VALUES (${user.workspaceId}, ${invitee.userId}, 'admin', ${invitee.email})
    `.execute(getDb())
    expect((await methods.listWorkspaceNotificationRecipients(user.workspaceId)).map(r => r.userId)).not.toContain(invitee.userId)

    await sql`UPDATE public.workspace_members SET accepted_at = now() WHERE workspace_id = ${user.workspaceId} AND user_id = ${invitee.userId}`.execute(getDb())
    expect((await methods.listWorkspaceNotificationRecipients(user.workspaceId)).map(r => r.userId)).toContain(invitee.userId)
    await deleteSeededUser(invitee.userId)
  })
})
