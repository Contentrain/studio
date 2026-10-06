import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

/**
 * Account deletion (auth.users → profiles cascade) must never be pinned by a
 * creator/audit stamp on a record that outlives its creator. The scenario is
 * the transfer one: a member created things in a workspace someone else owns,
 * then deleted their account.
 */
describe('account deletion vs creator foreign keys (contract)', () => {
  let owner: SeededUser
  let leaver: SeededUser
  let projectId: string

  beforeAll(async () => {
    owner = await seedUser('owner')
    leaver = await seedUser('leaver')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${owner.workspaceId}, 'contentrain/account-delete-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(owner.userId)
  })

  it('no foreign key to profiles / auth.users blocks a delete (every action is CASCADE or SET NULL)', async () => {
    const blockers = await sql<{ tbl: string, col: string }>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND c.confrelid IN ('public.profiles'::regclass, 'auth.users'::regclass)
        AND c.confdeltype IN ('a', 'r')
    `.execute(getDb())
    expect(blockers.rows).toEqual([])
  })

  it('a user who created a key, media asset and form approval in another workspace can be deleted; the records stay with a null creator', async () => {
    const key = await sql<{ id: string }>`
      INSERT INTO public.mcp_cloud_keys (project_id, workspace_id, key_hash, key_prefix, name, created_by)
      VALUES (${projectId}, ${owner.workspaceId}, ${randomUUID()}, 'mcp_live1', 'leaver-key', ${leaver.userId})
      RETURNING id
    `.execute(getDb())
    const asset = await sql<{ id: string }>`
      INSERT INTO public.media_assets
        (project_id, workspace_id, filename, content_type, size_bytes, content_hash, format, original_path, uploaded_by)
      VALUES (${projectId}, ${owner.workspaceId}, 'a.webp', 'image/webp', 1, ${randomUUID()}, 'webp', ${`media/${randomUUID()}.webp`}, ${leaver.userId})
      RETURNING id
    `.execute(getDb())
    const submission = await sql<{ id: string }>`
      INSERT INTO public.form_submissions (project_id, workspace_id, model_id, data, status, approved_by)
      VALUES (${projectId}, ${owner.workspaceId}, 'contact-form', '{}'::jsonb, 'approved', ${leaver.userId})
      RETURNING id
    `.execute(getDb())

    await deleteSeededUser(leaver.userId)

    const keyRow = await sql<{ created_by: string | null }>`SELECT created_by FROM public.mcp_cloud_keys WHERE id = ${key.rows[0]!.id}`.execute(getDb())
    const assetRow = await sql<{ uploaded_by: string | null }>`SELECT uploaded_by FROM public.media_assets WHERE id = ${asset.rows[0]!.id}`.execute(getDb())
    const submissionRow = await sql<{ approved_by: string | null }>`SELECT approved_by FROM public.form_submissions WHERE id = ${submission.rows[0]!.id}`.execute(getDb())
    expect(keyRow.rows).toEqual([{ created_by: null }])
    expect(assetRow.rows).toEqual([{ uploaded_by: null }])
    expect(submissionRow.rows).toEqual([{ approved_by: null }])
  })
})
