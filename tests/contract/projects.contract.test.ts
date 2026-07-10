import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectMethods } from '../../server/providers/postgres-db/projects'
import { deleteSeededUser, getDb, mintAccessToken, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db projects (contract)', () => {
  const methods = projectMethods()
  let owner: SeededUser
  let assignee: SeededUser
  let ownerToken: string
  let projectId: string
  const repo = `contentrain/proj-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    owner = await seedUser('proj-owner')
    assignee = await seedUser('proj-assignee')
    ownerToken = await mintAccessToken(owner.userId)
  })

  afterAll(async () => {
    await deleteSeededUser(owner.userId)
    await deleteSeededUser(assignee.userId)
  })

  it('createProject inserts under RLS and getProjectById projects flat fields', async () => {
    const created = await methods.createProject(ownerToken, {
      workspace_id: owner.workspaceId,
      repo_full_name: repo,
    })
    projectId = created.id as string

    expect(created.status).toBe('active')
    expect(created.default_branch).toBe('main')
    expect(created.access_status).toBe('accessible')

    const fetched = await methods.getProjectById(projectId, 'id, repo_full_name, content_root')
    expect(Object.keys(fetched!).sort()).toEqual(['content_root', 'id', 'repo_full_name'])
    expect(fetched!.content_root).toBe('/')

    expect(await methods.getProjectById(randomUUID())).toBeNull()
  })

  it('checkDuplicateProject flags only the exact workspace+repo pair', async () => {
    expect(await methods.checkDuplicateProject(owner.workspaceId, repo)).toBe(true)
    expect(await methods.checkDuplicateProject(owner.workspaceId, 'contentrain/other')).toBe(false)
    expect(await methods.checkDuplicateProject(assignee.workspaceId, repo)).toBe(false)
  })

  it('getProjectWithMembers embeds members strictly inside the caller\'s RLS scope', async () => {
    await methods.createProjectMember({
      projectId,
      workspaceId: owner.workspaceId,
      userId: assignee.userId,
      role: 'editor',
      invitedEmail: assignee.email,
    })

    // pm SELECT policy is own-row-only ("Users can view own project
    // memberships") — the owner has no pm row, so the embed is EMPTY for the
    // owner, exactly as PostgREST's RLS-scoped embed behaves. Admin surfaces
    // use listProjectMembers (service path) instead.
    const asOwner = await methods.getProjectWithMembers(ownerToken, owner.workspaceId, projectId)
    expect(asOwner).not.toBeNull()
    expect(asOwner!.project_members).toEqual([])

    // the assignee sees the project through their pm row, and the embed
    // contains exactly that own row with the profile shape
    const assigneeToken = await mintAccessToken(assignee.userId)
    const asAssignee = await methods.getProjectWithMembers(assigneeToken, owner.workspaceId, projectId)
    const embedded = asAssignee!.project_members as Array<Record<string, unknown>>
    expect(embedded).toHaveLength(1)
    expect(Object.keys(embedded[0]!).sort()).toEqual(
      ['accepted_at', 'allowed_models', 'id', 'invited_email', 'profiles', 'role', 'specific_models', 'user_id'],
    )
    expect((embedded[0]!.profiles as Record<string, unknown>).email).toBe(assignee.email)
    expect(embedded[0]!.allowed_models).toEqual([])

    // wrong workspace scope → null (single() → PGRST116 parity)
    expect(await methods.getProjectWithMembers(ownerToken, assignee.workspaceId, projectId)).toBeNull()
  })

  it('lists workspace projects newest-first on both trust paths', async () => {
    const second = await methods.createProject(ownerToken, {
      workspace_id: owner.workspaceId,
      repo_full_name: `${repo}-second`,
      created_at: new Date(Date.now() + 1000).toISOString(),
    })

    const viaUser = await methods.listWorkspaceProjects(ownerToken, owner.workspaceId)
    expect(viaUser.map(p => p.id)).toEqual([second.id, projectId])

    const viaAdmin = await methods.listWorkspaceProjectsAdmin(owner.workspaceId)
    expect(viaAdmin.map(p => p.id)).toEqual([second.id, projectId])

    const byIds = await methods.listWorkspaceProjectsByIds(owner.workspaceId, [projectId])
    expect(byIds.map(p => p.id)).toEqual([projectId])
    expect(await methods.listWorkspaceProjectsByIds(owner.workspaceId, [])).toEqual([])

    await methods.deleteProject(second.id as string, owner.workspaceId)
  })

  it('assignment lookups resolve via project_members on both trust paths', async () => {
    expect(await methods.listUserAssignedProjectIds(assignee.userId)).toEqual([projectId])

    const assigneeToken = await mintAccessToken(assignee.userId)
    const viaUser = await methods.listUserAssignedProjects(assigneeToken, assignee.userId)
    expect(viaUser).toEqual([{ project_id: projectId }])

    expect(await methods.listUserAssignedProjectIds(owner.userId)).toEqual([])
  })

  it('updateProject + content timestamp + installation-scoped access/rename', async () => {
    const updated = await methods.updateProject(projectId, { detected_stack: 'nuxt' }, 'id, detected_stack')
    expect(updated.detected_stack).toBe('nuxt')

    await methods.updateProjectContentTimestamp(repo)
    const stamped = await methods.getProjectById(projectId, 'content_updated_at')
    expect(stamped!.content_updated_at).not.toBeNull()

    // bind an installation to the workspace; a control project in another
    // workspace shares the repo name but must stay untouched
    const installationId = 880011
    await sql`UPDATE public.workspaces SET github_installation_id = ${installationId} WHERE id = ${owner.workspaceId}`.execute(getDb())
    const control = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name) VALUES (${assignee.workspaceId}, ${repo}) RETURNING id
    `.execute(getDb())

    await methods.updateProjectAccessStatus({ installationId, repoFullName: repo }, 'inaccessible')
    expect((await methods.getProjectById(projectId, 'access_status'))!.access_status).toBe('inaccessible')
    expect((await methods.getProjectById(control.rows[0]!.id, 'access_status'))!.access_status).toBe('accessible')

    const renamed = `${repo}-renamed`
    await methods.renameProjectRepo({ installationId, oldFullName: repo }, renamed)
    expect((await methods.getProjectById(projectId, 'repo_full_name'))!.repo_full_name).toBe(renamed)
    expect((await methods.getProjectById(control.rows[0]!.id, 'repo_full_name'))!.repo_full_name).toBe(repo)

    // restore for later specs
    await methods.renameProjectRepo({ installationId, oldFullName: renamed }, repo)
    await methods.updateProjectAccessStatus({ installationId, repoFullName: repo }, 'accessible')
  })

  it('listCDNEnabledProjects and listAllActiveProjects filter + project fields', async () => {
    expect(await methods.listCDNEnabledProjects(repo)).toEqual([])

    await methods.updateProject(projectId, { cdn_enabled: true, cdn_branch: 'contentrain' })
    const cdn = await methods.listCDNEnabledProjects(repo)
    expect(cdn).toHaveLength(1)
    expect(Object.keys(cdn[0]!).sort()).toEqual(
      ['cdn_branch', 'cdn_enabled', 'content_root', 'default_branch', 'id', 'workspace_id'],
    )

    const active = await methods.listAllActiveProjects()
    const mine = active.find(p => p.id === projectId)!
    expect(Object.keys(mine).sort()).toEqual(['content_root', 'id', 'repo_full_name', 'workspace_id'])
  })

  it('getProjectMediaStorageSum sums media_assets and returns 0 when empty', async () => {
    expect(await methods.getProjectMediaStorageSum(projectId)).toBe(0)

    for (const size of [1000, 2500]) {
      await sql`
        INSERT INTO public.media_assets
          (project_id, workspace_id, filename, content_type, size_bytes, content_hash, format, original_path, uploaded_by)
        VALUES
          (${projectId}, ${owner.workspaceId}, 'a.webp', 'image/webp', ${size}, ${randomUUID()}, 'webp', 'media/original/a.webp', ${owner.userId})
      `.execute(getDb())
    }

    expect(await methods.getProjectMediaStorageSum(projectId)).toBe(3500)
  })

  it('project member helpers: list shape, lookup, delete', async () => {
    const list = await methods.listProjectMembers(projectId)
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(
      ['accepted_at', 'allowed_models', 'id', 'invited_at', 'invited_email', 'profiles', 'role', 'specific_models', 'user_id'],
    )

    const member = await methods.getProjectMember(projectId, assignee.userId)
    expect(Object.keys(member!).sort()).toEqual(['allowed_models', 'id', 'role', 'specific_models'])
    expect(member!.role).toBe('editor')
    expect(await methods.getProjectMember(projectId, owner.userId)).toBeNull()

    await methods.deleteProjectMember(projectId, member!.id as string)
    expect(await methods.getProjectMember(projectId, assignee.userId)).toBeNull()
  })

  it('deleteProject removes the project scoped to its workspace', async () => {
    await methods.deleteProject(projectId, assignee.workspaceId) // wrong workspace → no-op
    expect(await methods.getProjectById(projectId, 'id')).not.toBeNull()

    await methods.deleteProject(projectId, owner.workspaceId)
    expect(await methods.getProjectById(projectId, 'id')).toBeNull()
  })
})
