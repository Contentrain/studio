import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { workspaceMethods } from '../../server/providers/postgres-db/workspaces'
import { memberMethods } from '../../server/providers/postgres-db/members'
import { deleteSeededUser, getDb, mintAccessToken, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db workspaces (contract)', () => {
  const methods = workspaceMethods()
  const members = memberMethods()
  let owner: SeededUser
  let member: SeededUser
  let outsider: SeededUser
  let ownerToken: string
  let memberToken: string
  let outsiderToken: string

  beforeAll(async () => {
    owner = await seedUser('ws-owner')
    member = await seedUser('ws-member')
    outsider = await seedUser('ws-outsider')
    ownerToken = await mintAccessToken(owner.userId)
    memberToken = await mintAccessToken(member.userId)
    outsiderToken = await mintAccessToken(outsider.userId)

    // member joins the owner's primary workspace as plain member
    await members.createWorkspaceMember(ownerToken, owner.userId, {
      workspaceId: owner.workspaceId,
      memberUserId: member.userId,
      role: 'member',
      invitedEmail: member.email,
      acceptedAt: new Date().toISOString(),
    })
  })

  afterAll(async () => {
    await deleteSeededUser(owner.userId)
    await deleteSeededUser(member.userId)
    await deleteSeededUser(outsider.userId)
  })

  it('listUserWorkspaces returns per-workspace roles without the owner-policy collapse', async () => {
    const ownerList = await methods.listUserWorkspaces(ownerToken, owner.userId)
    const ownRow = ownerList.find(w => w.id === owner.workspaceId)!
    expect((ownRow.workspace_members as Array<{ role: string }>)[0]!.role).toBe('owner')
    expect(ownRow).toHaveProperty('payment_account')

    // The wm_owner_manage guard: the member must resolve to 'member' even
    // though the workspace has two visible membership rows.
    const memberList = await methods.listUserWorkspaces(memberToken, member.userId)
    const joinedRow = memberList.find(w => w.id === owner.workspaceId)!
    expect((joinedRow.workspace_members as Array<{ role: string }>)[0]!.role).toBe('member')
  })

  it('createWorkspace inserts under RLS and the trigger adds the owner membership', async () => {
    const slug = `contract-sec-${randomUUID().slice(0, 8)}`
    const created = await methods.createWorkspace(ownerToken, {
      name: 'Contract Secondary',
      slug,
      type: 'secondary',
      ownerId: owner.userId,
    })

    expect(created.slug).toBe(slug)

    const membership = await sql<{ role: string }>`
      SELECT role FROM public.workspace_members
      WHERE workspace_id = ${created.id as string} AND user_id = ${owner.userId}
    `.execute(getDb())
    expect(membership.rows[0]!.role).toBe('owner')

    // duplicate slug → 409 contract
    await expect(
      methods.createWorkspace(ownerToken, { name: 'Dup', slug, type: 'secondary', ownerId: owner.userId }),
    ).rejects.toMatchObject({ statusCode: 409 })

    await methods.deleteWorkspace(created.id as string)
  })

  it('getWorkspaceForUser enforces roles and projects flat fields', async () => {
    const row = await methods.getWorkspaceForUser(ownerToken, owner.userId, owner.workspaceId, ['owner', 'admin'], 'id, slug, plan')
    expect(Object.keys(row!).sort()).toEqual(['id', 'plan', 'slug'])

    await expect(
      methods.getWorkspaceForUser(memberToken, member.userId, owner.workspaceId, ['owner', 'admin']),
    ).rejects.toMatchObject({ statusCode: 403 })

    await expect(
      methods.getWorkspaceForUser(outsiderToken, outsider.userId, owner.workspaceId),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('getWorkspaceDetailForUser embeds members with profiles and the payment account', async () => {
    const detail = await methods.getWorkspaceDetailForUser(ownerToken, owner.userId, owner.workspaceId)

    expect(detail).not.toBeNull()
    expect(detail!).toHaveProperty('payment_account')
    const embedded = detail!.workspace_members as Array<Record<string, unknown>>
    expect(embedded.length).toBe(2)
    const memberRow = embedded.find(m => m.user_id === member.userId)!
    expect(Object.keys(memberRow).sort()).toEqual(
      ['accepted_at', 'id', 'invited_email', 'profiles', 'role', 'user_id'],
    )
    expect((memberRow.profiles as Record<string, unknown>).email).toBe(member.email)
  })

  it('updateWorkspace supports both the system path (empty token) and the RLS path', async () => {
    const viaSystem = await methods.updateWorkspace('', owner.workspaceId, { logo_url: 'https://cdn.example/logo.png' }, 'id, logo_url')
    expect(viaSystem.logo_url).toBe('https://cdn.example/logo.png')

    const viaUser = await methods.updateWorkspace(ownerToken, owner.workspaceId, { logo_url: null }, 'id, logo_url')
    expect(viaUser.logo_url).toBeNull()
  })

  it('markWorkspaceTrialConsumed is set-once', async () => {
    await methods.markWorkspaceTrialConsumed(owner.workspaceId)
    const first = await sql<{ trial_consumed_at: string }>`
      SELECT trial_consumed_at FROM public.workspaces WHERE id = ${owner.workspaceId}
    `.execute(getDb())

    await new Promise(resolve => setTimeout(resolve, 25))
    await methods.markWorkspaceTrialConsumed(owner.workspaceId)
    const second = await sql<{ trial_consumed_at: string }>`
      SELECT trial_consumed_at FROM public.workspaces WHERE id = ${owner.workspaceId}
    `.execute(getDb())

    expect(second.rows[0]!.trial_consumed_at).toBe(first.rows[0]!.trial_consumed_at)
  })

  it('getPrimaryWorkspace and getWorkspaceMemberRole resolve for the caller', async () => {
    const primary = await methods.getPrimaryWorkspace(ownerToken, owner.userId)
    expect(primary!.id).toBe(owner.workspaceId)

    expect(await methods.getWorkspaceMemberRole(memberToken, member.userId, owner.workspaceId)).toBe('member')
    expect(await methods.getWorkspaceMemberRole(outsiderToken, outsider.userId, owner.workspaceId)).toBeNull()
    expect(await methods.getWorkspaceMemberRole('broken-token', member.userId, owner.workspaceId)).toBeNull()
  })

  it('github installation binding: find / update / clear / status by both targets', async () => {
    const installationId = 990001

    await methods.updateWorkspaceGithubInstallation(owner.workspaceId, installationId)
    const found = await methods.findWorkspaceByGithubInstallation(installationId)
    expect(found!.id).toBe(owner.workspaceId)
    expect(await methods.findWorkspaceByGithubInstallation(installationId, owner.workspaceId)).toBeNull()

    await methods.updateWorkspaceInstallationStatus({ installationId }, 'suspended')
    let status = await sql<{ github_installation_status: string }>`
      SELECT github_installation_status FROM public.workspaces WHERE id = ${owner.workspaceId}
    `.execute(getDb())
    expect(status.rows[0]!.github_installation_status).toBe('suspended')

    await methods.updateWorkspaceInstallationStatus({ workspaceId: owner.workspaceId }, 'active')
    await methods.clearWorkspaceGithubInstallation(installationId)
    status = await sql<{ github_installation_status: string }>`
      SELECT github_installation_status FROM public.workspaces WHERE id = ${owner.workspaceId}
    `.execute(getDb())
    expect(status.rows[0]!.github_installation_status).toBe('unbound')
  })

  it('storage RPCs: increment applies deltas, reserve enforces the limit atomically', async () => {
    await methods.incrementWorkspaceStorageBytes(owner.workspaceId, 1000)

    const allowed = await methods.reserveStorageIfAllowed(owner.workspaceId, 500, 2000)
    expect(allowed.allowed).toBe(true)

    const denied = await methods.reserveStorageIfAllowed(owner.workspaceId, 10_000, 2000)
    expect(denied.allowed).toBe(false)

    await methods.incrementWorkspaceStorageBytes(owner.workspaceId, -(Number(allowed.currentBytes) + 500))
  })

  it('transferWorkspaceOwnership swaps owner_id and both member roles atomically', async () => {
    await methods.transferWorkspaceOwnership(owner.workspaceId, owner.userId, member.userId)

    const state = await sql<{ owner_id: string }>`
      SELECT owner_id FROM public.workspaces WHERE id = ${owner.workspaceId}
    `.execute(getDb())
    expect(state.rows[0]!.owner_id).toBe(member.userId)

    expect(await methods.getWorkspaceMemberRole(ownerToken, owner.userId, owner.workspaceId)).toBe('admin')
    expect(await methods.getWorkspaceMemberRole(memberToken, member.userId, owner.workspaceId)).toBe('owner')

    // revert for the remaining specs
    await methods.transferWorkspaceOwnership(owner.workspaceId, member.userId, owner.userId)
    await sql`
      UPDATE public.workspace_members SET role = 'member'
      WHERE workspace_id = ${owner.workspaceId} AND user_id = ${member.userId}
    `.execute(getDb())
  })

  it('listOwnedSecondaryWorkspacesWithMembers returns the compact embed shape', async () => {
    const slug = `contract-list-${randomUUID().slice(0, 8)}`
    const created = await methods.createWorkspace(ownerToken, {
      name: 'List Secondary',
      slug,
      type: 'secondary',
      ownerId: owner.userId,
    })

    const list = await methods.listOwnedSecondaryWorkspacesWithMembers(ownerToken, owner.userId)
    const row = list.find(w => w.id === created.id)!
    expect(Object.keys(row).sort()).toEqual(['id', 'name', 'owner_id', 'slug', 'type', 'workspace_members'])

    const embedded = row.workspace_members as Array<Record<string, unknown>>
    expect(Object.keys(embedded[0]!).sort()).toEqual(['id', 'profiles', 'role', 'user_id'])

    await methods.deleteWorkspace(created.id as string)
    const after = await methods.listOwnedSecondaryWorkspacesWithMembers(ownerToken, owner.userId)
    expect(after.find(w => w.id === created.id)).toBeUndefined()
  })
})
