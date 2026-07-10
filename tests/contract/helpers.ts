/**
 * Seed + token helpers for the contract suite.
 *
 * Seeding goes straight through SQL on the provider's own pool: inserting
 * into auth.users exercises the real signup bootstrap chain
 * (handle_new_user → profile + primary workspace → owner membership), so
 * every spec starts from the same state a real signup produces.
 */
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { sql } from 'kysely'
import { getDb } from '../../server/providers/postgres-db/client'
import { CONTRACT_JWT_SECRET } from './env'

const encoder = new TextEncoder()

export interface SeededUser {
  userId: string
  email: string
  workspaceId: string
}

/** Insert an auth.users row; the trigger chain bootstraps profile + workspace. */
export async function seedUser(label = 'user', meta: Record<string, unknown> = {}): Promise<SeededUser> {
  const email = `${label}-${randomUUID()}@contract.test`
  const rawMeta = JSON.stringify({ full_name: 'Contract User', ...meta })

  const inserted = await sql<{ id: string }>`
    INSERT INTO auth.users (email, raw_user_meta_data)
    VALUES (${email}, ${rawMeta}::jsonb)
    RETURNING id
  `.execute(getDb())
  const userId = inserted.rows[0]!.id

  const workspace = await sql<{ id: string }>`
    SELECT id FROM public.workspaces WHERE owner_id = ${userId} AND type = 'primary'
  `.execute(getDb())

  return { userId, email, workspaceId: workspace.rows[0]!.id }
}

/** Cascade-delete a seeded user (profiles/workspaces/members follow via FK). */
export async function deleteSeededUser(userId: string): Promise<void> {
  await sql`DELETE FROM auth.users WHERE id = ${userId}`.execute(getDb())
}

/** Mint a managed-auth-shaped access token for the given subject. */
export async function mintAccessToken(userId: string, options: { expired?: boolean } = {}): Promise<string> {
  const jwt = new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(options.expired ? Math.floor(Date.now() / 1000) - 7200 : undefined)

  jwt.setExpirationTime(options.expired ? Math.floor(Date.now() / 1000) - 3600 : '1h')

  return jwt.sign(encoder.encode(CONTRACT_JWT_SECRET))
}

/** Raw SQL escape hatch for spec-specific seeding/assertions. */
export { sql }
export { getDb }
