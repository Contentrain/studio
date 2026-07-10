import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memberMethods } from '../../server/providers/postgres-db/members'
import { deleteSeededUser, getDb, mintAccessToken, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db members (contract)', () => {
  const methods = memberMethods()
  let owner: SeededUser
  let invitee: SeededUser
  let extra: SeededUser
  let ownerToken: string
  let inviteeToken: string
  let projectId: string

  beforeAll(async () => {
    owner = await seedUser('m-owner')
    invitee = await seedUser('m-invitee')
    extra = await seedUser('m-extra')
    ownerToken = await mintAccessToken(owner.userId)
    inviteeToken = await mintAccessToken(invitee.userId)

    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${owner.workspaceId}, 'contentrain/contract-fixture')
      RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(owner.userId)
    await deleteSeededUser(invitee.userId)
    await deleteSeededUser(extra.userId)
  })

  it('createWorkspaceMember returns the profile-embedded row; listing requires owner/admin', async () => {
    const created = await methods.createWorkspaceMember(ownerToken, owner.userId, {
      workspaceId: owner.workspaceId,
      memberUserId: invitee.userId,
      role: 'member',
      invitedEmail: invitee.email,
      acceptedAt: null,
    })

    expect(Object.keys(created).sort()).toEqual(
      ['accepted_at', 'id', 'invited_at', 'invited_email', 'profiles', 'role', 'user_id'],
    )
    expect((created.profiles as Record<string, unknown>).email).toBe(invitee.email)

    const list = await methods.listWorkspaceMembers(ownerToken, owner.userId, owner.workspaceId)
    expect(list.map(m => m.user_id)).toContain(invitee.userId)

    // plain member (not yet accepted → still member row exists) cannot list
    await expect(
      methods.listWorkspaceMembers(inviteeToken, invitee.userId, owner.workspaceId),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('getWorkspaceMember returns the row or null for an unknown id', async () => {
    const list = await methods.listWorkspaceMembers(ownerToken, owner.userId, owner.workspaceId)
    const target = list.find(m => m.user_id === invitee.userId)!

    const fetched = await methods.getWorkspaceMember(ownerToken, owner.userId, owner.workspaceId, target.id as string)
    expect(fetched!.user_id).toBe(invitee.userId)

    expect(await methods.getWorkspaceMember(ownerToken, owner.userId, owner.workspaceId, randomUUID())).toBeNull()
  })

  it('acceptPendingInvitations flips workspace + project rows atomically and is idempotent', async () => {
    await sql`
      INSERT INTO public.project_members (project_id, user_id, role)
      VALUES (${projectId}, ${invitee.userId}, 'editor')
    `.execute(getDb())

    expect(await methods.acceptPendingInvitations(invitee.userId, owner.workspaceId)).toBe(true)

    const wm = await sql<{ accepted_at: string | null }>`
      SELECT accepted_at FROM public.workspace_members
      WHERE workspace_id = ${owner.workspaceId} AND user_id = ${invitee.userId}
    `.execute(getDb())
    expect(wm.rows[0]!.accepted_at).not.toBeNull()

    const pm = await sql<{ accepted_at: string | null }>`
      SELECT accepted_at FROM public.project_members
      WHERE project_id = ${projectId} AND user_id = ${invitee.userId}
    `.execute(getDb())
    expect(pm.rows[0]!.accepted_at).not.toBeNull()

    // nothing left pending → false
    expect(await methods.acceptPendingInvitations(invitee.userId, owner.workspaceId)).toBe(false)
  })

  it('updateWorkspaceMemberRole: 404 unknown, 400 owner target, owner-only guard, success path', async () => {
    const list = await methods.listWorkspaceMembers(ownerToken, owner.userId, owner.workspaceId)
    const target = list.find(m => m.user_id === invitee.userId)!
    const ownerRow = list.find(m => m.user_id === owner.userId)!

    await expect(
      methods.updateWorkspaceMemberRole(ownerToken, owner.userId, owner.workspaceId, randomUUID(), 'admin'),
    ).rejects.toMatchObject({ statusCode: 404 })

    await expect(
      methods.updateWorkspaceMemberRole(ownerToken, owner.userId, owner.workspaceId, ownerRow.id as string, 'admin'),
    ).rejects.toMatchObject({ statusCode: 400 })

    const updated = await methods.updateWorkspaceMemberRole(ownerToken, owner.userId, owner.workspaceId, target.id as string, 'admin')
    expect(updated.role).toBe('admin')

    // now-admin invitee still cannot change roles (owner-only)
    await expect(
      methods.updateWorkspaceMemberRole(inviteeToken, invitee.userId, owner.workspaceId, target.id as string, 'member'),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('createWorkspaceMemberIfAllowed enforces the seat limit atomically', async () => {
    // workspace currently has 2 members (owner + invitee-as-admin)
    const denied = await methods.createWorkspaceMemberIfAllowed({
      accessToken: ownerToken,
      callerUserId: owner.userId,
      workspaceId: owner.workspaceId,
      memberUserId: extra.userId,
      role: 'member',
      invitedEmail: extra.email,
      acceptedAt: null,
      limit: 2,
    })
    expect(denied.allowed).toBe(false)
    expect(denied.currentCount).toBe(2)

    const granted = await methods.createWorkspaceMemberIfAllowed({
      accessToken: ownerToken,
      callerUserId: owner.userId,
      workspaceId: owner.workspaceId,
      memberUserId: extra.userId,
      role: 'member',
      invitedEmail: extra.email,
      acceptedAt: null,
      limit: 10,
    })
    expect(granted.allowed).toBe(true)
    expect(granted.member).toBeDefined()
    expect((granted.member!.profiles as Record<string, unknown>).email).toBe(extra.email)

    const repeat = await methods.createWorkspaceMemberIfAllowed({
      accessToken: ownerToken,
      callerUserId: owner.userId,
      workspaceId: owner.workspaceId,
      memberUserId: extra.userId,
      role: 'member',
      invitedEmail: extra.email,
      acceptedAt: null,
      limit: 10,
    })
    expect(repeat.allowed).toBe(true)
    expect(repeat.alreadyExisted).toBe(true)
  })

  it('deleteWorkspaceMember guards the owner row and deletes members', async () => {
    const list = await methods.listWorkspaceMembers(ownerToken, owner.userId, owner.workspaceId)
    const ownerRow = list.find(m => m.user_id === owner.userId)!
    const extraRow = list.find(m => m.user_id === extra.userId)!

    await expect(
      methods.deleteWorkspaceMember(ownerToken, owner.userId, owner.workspaceId, ownerRow.id as string),
    ).rejects.toMatchObject({ statusCode: 400 })

    await methods.deleteWorkspaceMember(ownerToken, owner.userId, owner.workspaceId, extraRow.id as string)
    expect(await methods.getWorkspaceMember(ownerToken, owner.userId, owner.workspaceId, extraRow.id as string)).toBeNull()
  })

  it('updateWorkspaceMemberInvitedAt + ensureWorkspaceMember (idempotent)', async () => {
    const list = await methods.listWorkspaceMembers(ownerToken, owner.userId, owner.workspaceId)
    const target = list.find(m => m.user_id === invitee.userId)!

    const stamp = new Date(Date.now() - 3600_000).toISOString()
    await methods.updateWorkspaceMemberInvitedAt(ownerToken, owner.userId, owner.workspaceId, target.id as string, stamp)
    const reread = await methods.getWorkspaceMember(ownerToken, owner.userId, owner.workspaceId, target.id as string)
    expect(Date.parse(reread!.invited_at as string)).toBe(Date.parse(stamp))

    // existing membership → no duplicate
    await methods.ensureWorkspaceMember(inviteeToken, owner.workspaceId, invitee.userId, invitee.email)
    const count = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.workspace_members
      WHERE workspace_id = ${owner.workspaceId} AND user_id = ${invitee.userId}
    `.execute(getDb())
    expect(count.rows[0]!.count).toBe(1)

    // new membership → inserted with pending accepted_at
    await methods.ensureWorkspaceMember(await mintAccessToken(extra.userId), owner.workspaceId, extra.userId, extra.email)
    const inserted = await sql<{ accepted_at: string | null }>`
      SELECT accepted_at FROM public.workspace_members
      WHERE workspace_id = ${owner.workspaceId} AND user_id = ${extra.userId}
    `.execute(getDb())
    expect(inserted.rows).toHaveLength(1)
    expect(inserted.rows[0]!.accepted_at).toBeNull()
  })

  it('listWorkspaceAdminEmails returns accepted owner/admin profiles only', async () => {
    const admins = await methods.listWorkspaceAdminEmails(owner.workspaceId)
    const emails = admins.map(a => a.email)

    expect(emails).toContain(owner.email) // accepted owner (bootstrap)
    expect(emails).toContain(invitee.email) // accepted admin (earlier spec)
    expect(emails).not.toContain(extra.email) // pending member, wrong role
  })

  it('AI keys: RLS-scoped CRUD with upsert rotation', async () => {
    const created = await methods.upsertUserAIKey(ownerToken, {
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      provider: 'anthropic',
      encryptedKey: 'v1:cipher-a',
      keyHint: '…key1',
    })
    expect(Object.keys(created).sort()).toEqual(['created_at', 'id', 'key_hint', 'provider'])

    const rotated = await methods.upsertUserAIKey(ownerToken, {
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      provider: 'anthropic',
      encryptedKey: 'v1:cipher-b',
      keyHint: '…key2',
    })
    expect(rotated.id).toBe(created.id)
    expect(rotated.key_hint).toBe('…key2')

    const mine = await methods.listUserAIKeys(ownerToken, owner.workspaceId, owner.userId)
    expect(mine).toHaveLength(1)

    // another member sees nothing of the owner's keys (RLS self-scope)
    const theirs = await methods.listUserAIKeys(inviteeToken, owner.workspaceId, owner.userId)
    expect(theirs).toHaveLength(0)

    await methods.deleteUserAIKey(ownerToken, owner.workspaceId, created.id as string, owner.userId)
    expect(await methods.listUserAIKeys(ownerToken, owner.workspaceId, owner.userId)).toHaveLength(0)
  })

  it('getProjectForWorkspace projects flat fields under RLS', async () => {
    const row = await methods.getProjectForWorkspace(ownerToken, owner.workspaceId, projectId, 'id, repo_full_name, status')
    expect(Object.keys(row!).sort()).toEqual(['id', 'repo_full_name', 'status'])
    expect(row!.repo_full_name).toBe('contentrain/contract-fixture')

    expect(await methods.getProjectForWorkspace(ownerToken, owner.workspaceId, randomUUID())).toBeNull()
  })

  it('webhook helpers: count + create with the public column subset', async () => {
    expect(await methods.countProjectWebhooks(projectId, owner.workspaceId)).toBe(0)

    const webhook = await methods.createWebhook({
      projectId,
      workspaceId: owner.workspaceId,
      name: 'contract-hook',
      url: 'https://example.com/hook',
      events: ['content.published', 'content.deleted'],
      secret: 'whsec_contract',
    })

    expect(Object.keys(webhook).sort()).toEqual(['active', 'created_at', 'events', 'id', 'name', 'url'])
    expect(webhook.active).toBe(true)
    expect(webhook.events).toEqual(['content.published', 'content.deleted'])

    expect(await methods.countProjectWebhooks(projectId, owner.workspaceId)).toBe(1)
  })
})
