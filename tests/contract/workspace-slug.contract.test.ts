import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'

// What @contentrain/types accepts as the workspace slug Studio answers Migrate with.
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

describe('workspace slugs (contract)', () => {
  const users: string[] = []
  const created: string[] = []
  afterAll(async () => {
    for (const id of created) await sql`DELETE FROM public.workspaces WHERE id = ${id}`.execute(getDb())
    for (const id of users) await deleteSeededUser(id)
  })

  const slugOf = async (workspaceId: string) =>
    (await sql<{ slug: string }>`SELECT slug FROM public.workspaces WHERE id = ${workspaceId}`.execute(getDb())).rows[0]!.slug

  it.each([
    ['capitals (a GitHub name like ABB65)', 'ABB65', /^abb65-[0-9a-f]{8}$/],
    ['dots and underscores', 'Jane.Doe_X', /^jane-doe-x-[0-9a-f]{8}$/],
    ['nothing usable', '__', /^user-[0-9a-f]{8}$/],
  ])('a new user whose name has %s gets a valid primary workspace slug', async (_label, userName, expected) => {
    const user = await seedUser('slug', { user_name: userName })
    users.push(user.userId)
    const slug = await slugOf(user.workspaceId)
    expect(slug).toMatch(SLUG)
    expect(slug).toMatch(expected)
  })

  it('the repair rewrites only invalid slugs, keeps them unique, and a second run changes nothing', async () => {
    const owner = await seedUser('slug-repair')
    users.push(owner.userId)
    const valid = `keep-${owner.userId.slice(0, 8)}`
    const bad = ['---65-1a2b3c4d', 'ABC_def', '!!!', 'a'.repeat(70)]
    for (const slug of [valid, ...bad]) {
      const row = await sql<{ id: string }>`
        INSERT INTO public.workspaces (name, slug, type, owner_id, plan)
        VALUES ('slug repair', ${slug}, 'secondary', ${owner.userId}, 'free') RETURNING id`.execute(getDb())
      created.push(row.rows[0]!.id)
    }
    const migration = readFileSync(new URL('../../supabase/migrations/047_workspace_slug_repair.sql', import.meta.url), 'utf8')
    const run = async () => {
      await sql.raw(migration).execute(getDb())
    }
    const slugs = async () => (await sql<{ slug: string }>`SELECT slug FROM public.workspaces WHERE id = ANY(${created})`.execute(getDb())).rows.map(r => r.slug)

    await run()
    const after = await slugs()
    expect(after).toContain(valid)
    expect(after.every(s => SLUG.test(s))).toBe(true)
    expect(new Set(after).size).toBe(after.length)
    await run()
    expect((await slugs()).sort()).toEqual(after.sort())
  })
})
