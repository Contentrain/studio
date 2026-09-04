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
