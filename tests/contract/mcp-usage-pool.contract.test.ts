import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { incrementOauthUsageIfAllowed } from '../../server/utils/oauth-server/store'
import type { SeededUser } from './helpers'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'

/**
 * Combined monthly MCP pool (migration 017) against real Postgres: the
 * API-key surface (mcp_cloud_usage) and the OAuth surface (mcp_oauth_usage)
 * draw on ONE `api.mcp_calls_per_month` budget — usage on either side must
 * block the other at the limit, and the workspace total must be the sum.
 */
describe('combined MCP usage pool (contract)', () => {
  let user: SeededUser
  let keyId: string
  const grantId = randomUUID() // bare uuid by design — no FK on the shared table
  const month = '2099-01'

  async function keyIncrement(limit: number | null): Promise<{ allowed: boolean, used: number }> {
    const outcome = await sql<{ result: { allowed: boolean, used: number } }>`
      SELECT public.increment_mcp_cloud_usage_if_allowed(
        p_workspace_id => ${user.workspaceId},
        p_month => ${month},
        p_key_id => ${keyId},
        p_limit => ${limit}
      ) AS result
    `.execute(getDb())
    return outcome.rows[0]!.result
  }

  function oauthIncrement(limit: number | null) {
    return incrementOauthUsageIfAllowed({ workspaceId: user.workspaceId, grantId, month, limit })
  }

  async function monthTotal(): Promise<number> {
    const outcome = await sql<{ total: number }>`
      SELECT public.workspace_mcp_month_total(
        p_workspace_id => ${user.workspaceId},
        p_month => ${month}
      ) AS total
    `.execute(getDb())
    return Number(outcome.rows[0]!.total)
  }

  beforeAll(async () => {
    user = await seedUser('mcp-pool')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/pool-fixture') RETURNING id
    `.execute(getDb())
    const key = await sql<{ id: string }>`
      INSERT INTO public.mcp_cloud_keys (workspace_id, project_id, key_hash, key_prefix, name)
      VALUES (${user.workspaceId}, ${project.rows[0]!.id}, ${randomUUID()}, 'crn_mcp_pool', 'pool-key')
      RETURNING id
    `.execute(getDb())
    keyId = key.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('sums both surfaces into one workspace total', async () => {
    expect(await monthTotal()).toBe(0)

    const key1 = await keyIncrement(null)
    expect(key1).toMatchObject({ allowed: true, used: 1 })

    const oauth1 = await oauthIncrement(null)
    expect(oauth1).toMatchObject({ allowed: true, used: 2 })

    expect(await monthTotal()).toBe(2)
  })

  it('key usage blocks the OAuth surface at the limit', async () => {
    // Pool currently at 2. Limit 3: one more key call fills it…
    expect(await keyIncrement(3)).toMatchObject({ allowed: true, used: 3 })
    // …and the OAuth surface is refused without writing a row.
    expect(await oauthIncrement(3)).toMatchObject({ allowed: false, used: 3 })
    expect(await monthTotal()).toBe(3)
  })

  it('OAuth usage blocks the key surface at the limit', async () => {
    expect(await oauthIncrement(4)).toMatchObject({ allowed: true, used: 4 })
    expect(await keyIncrement(4)).toMatchObject({ allowed: false, used: 4 })
    expect(await monthTotal()).toBe(4)
  })

  it('null limit means unlimited on both surfaces', async () => {
    expect(await keyIncrement(null)).toMatchObject({ allowed: true })
    expect(await oauthIncrement(null)).toMatchObject({ allowed: true })
  })
})
