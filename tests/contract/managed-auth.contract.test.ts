import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  completeOAuthSignIn,
  createCliAuthCode,
  createManagedAuthProvider,
} from '../../server/providers/managed-auth'
import { deleteSeededUser, getDb, sql } from './helpers'

const sendEmail = vi.fn(async (_options: { to: string, subject: string, html: string }) => {})
vi.stubGlobal('useEmailProvider', () => ({ sendEmail }))

function linkFromLastEmail(): URL {
  const html = sendEmail.mock.calls.at(-1)![0].html as string
  const match = html.match(/href="([^"]+\/api\/auth\/magic\/verify[^"]+)"/)
  expect(match, 'magic link href in email').toBeTruthy()
  return new URL(match![1]!.replace(/&amp;/g, '&'))
}

describe('managed-auth provider (contract)', () => {
  const auth = createManagedAuthProvider()
  const cleanupUserIds: string[] = []

  beforeAll(() => {
    sendEmail.mockClear()
  })

  afterAll(async () => {
    for (const id of cleanupUserIds)
      await deleteSeededUser(id).catch(() => {})
  })

  it('OAuth sign-in creates the user through the signup bootstrap chain', async () => {
    const email = `oauth-${randomUUID()}@managed.test`
    const session = await completeOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-${randomUUID()}`,
      email,
      name: 'Managed User',
      userName: 'managed-user',
      avatarUrl: 'https://avatars.example/u.png',
    })
    cleanupUserIds.push(session.user.id)

    expect(session.user.email).toBe(email)
    expect(session.user.provider).toBe('github')
    expect(session.user.avatarUrl).toBe('https://avatars.example/u.png')
    expect(session.tokens.refreshToken).toMatch(/^crt_/)

    // handle_new_user + handle_new_workspace fired exactly as on the Supabase pair
    const profile = await sql<{ display_name: string }>`
      SELECT display_name FROM public.profiles WHERE id = ${session.user.id}
    `.execute(getDb())
    expect(profile.rows[0]!.display_name).toBe('Managed User')

    const workspace = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.workspaces WHERE owner_id = ${session.user.id} AND type = 'primary'
    `.execute(getDb())
    expect(workspace.rows[0]!.count).toBe(1)
  })

  it('validateToken verifies locally and rejects tampered/expired tokens', async () => {
    const email = `jwt-${randomUUID()}@managed.test`
    const session = await completeOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-${randomUUID()}`,
      email,
      name: null,
      userName: null,
      avatarUrl: null,
    })
    cleanupUserIds.push(session.user.id)

    const user = await auth.validateToken(session.tokens.accessToken)
    expect(user).toEqual(session.user)

    expect(await auth.validateToken(`${session.tokens.accessToken}x`)).toBeNull()
    expect(await auth.validateToken('not-a-jwt')).toBeNull()
  })

  it('OAuth re-sign-in links by account and by email instead of duplicating', async () => {
    const email = `link-${randomUUID()}@managed.test`
    const accountId = `gh-${randomUUID()}`

    const first = await completeOAuthSignIn({
      provider: 'github',
      providerAccountId: accountId,
      email,
      name: 'Link User',
      userName: null,
      avatarUrl: null,
    })
    cleanupUserIds.push(first.user.id)

    const again = await completeOAuthSignIn({
      provider: 'github',
      providerAccountId: accountId,
      email,
      name: 'Link User',
      userName: null,
      avatarUrl: null,
    })
    expect(again.user.id).toBe(first.user.id)

    // same email arriving via a different provider → linked, not duplicated
    const viaGoogle = await completeOAuthSignIn({
      provider: 'google',
      providerAccountId: `g-${randomUUID()}`,
      email: email.toUpperCase(),
      name: 'Link User',
      userName: null,
      avatarUrl: null,
    })
    expect(viaGoogle.user.id).toBe(first.user.id)
    expect(viaGoogle.user.provider).toBe('google')
  })

  it('refreshSession rotates within a family and revokes the family on replay', async () => {
    const session = await completeOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-${randomUUID()}`,
      email: `rot-${randomUUID()}@managed.test`,
      name: null,
      userName: null,
      avatarUrl: null,
    })
    cleanupUserIds.push(session.user.id)
    const firstRefresh = session.tokens.refreshToken!

    const second = await auth.refreshSession(firstRefresh)
    expect(second).not.toBeNull()
    expect(second!.refreshToken).not.toBe(firstRefresh)
    expect(await auth.validateToken(second!.accessToken)).not.toBeNull()

    // reuse within the 10s grace window → tolerated (new pair, same family)
    const graceReuse = await auth.refreshSession(firstRefresh)
    expect(graceReuse).not.toBeNull()

    // simulate replay OUTSIDE the grace window → whole family revoked
    await sql`
      UPDATE auth.refresh_tokens SET rotated_at = now() - interval '60 seconds'
      WHERE user_id = ${session.user.id} AND rotated_at IS NOT NULL
    `.execute(getDb())
    expect(await auth.refreshSession(firstRefresh)).toBeNull()

    // the rotated-out successors died with the family
    expect(await auth.refreshSession(second!.refreshToken!)).toBeNull()
  })

  it('revokeSession kills the whole family (logout)', async () => {
    const session = await completeOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-${randomUUID()}`,
      email: `rev-${randomUUID()}@managed.test`,
      name: null,
      userName: null,
      avatarUrl: null,
    })
    cleanupUserIds.push(session.user.id)

    await auth.revokeSession!(session.tokens.refreshToken!)
    expect(await auth.refreshSession(session.tokens.refreshToken!)).toBeNull()
  })

  it('magic link: email → single-use token → session for a brand-new user', async () => {
    const email = `magic-${randomUUID()}@managed.test`
    await auth.sendMagicLink(email, '/w/home')

    expect(sendEmail).toHaveBeenCalled()
    const link = linkFromLastEmail()
    expect(link.searchParams.get('redirect')).toBe('/w/home')
    const token = link.searchParams.get('token')!
    expect(token).toMatch(/^mlc_/)

    const session = await auth.exchangeCode(token)
    cleanupUserIds.push(session.user.id)
    expect(session.user.email).toBe(email)
    expect(session.user.provider).toBe('email')

    // bootstrap fired for the email signup too
    const workspace = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.workspaces WHERE owner_id = ${session.user.id}
    `.execute(getDb())
    expect(workspace.rows[0]!.count).toBe(1)

    // single-use: second consume fails
    await expect(auth.exchangeCode(token)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('invite creates the user up front and its token signs them in', async () => {
    const email = `invite-${randomUUID()}@managed.test`
    const { userId } = await auth.inviteUserByEmail(email, { redirectTo: '/w/team' })
    cleanupUserIds.push(userId)

    expect((await auth.getUserById(userId))!.email).toBe(email)
    expect((await auth.getUserByEmail(email.toUpperCase()))!.id).toBe(userId)

    const link = linkFromLastEmail()
    const session = await auth.exchangeCode(link.searchParams.get('token')!)
    expect(session.user.id).toBe(userId)
  })

  it('CLI one-time code round-trips encrypted provider tokens', async () => {
    const session = await completeOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-${randomUUID()}`,
      email: `cli-${randomUUID()}@managed.test`,
      name: null,
      userName: null,
      avatarUrl: null,
    })
    cleanupUserIds.push(session.user.id)

    const code = await createCliAuthCode(session.user, {
      accessToken: 'gho_cli_token',
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    })
    expect(code).toMatch(/^otc_/)

    // ciphertext at rest — never the raw gho_ token
    const stored = await sql<{ payload: { provider_tokens: { access: string } } }>`
      SELECT payload FROM auth.one_time_tokens WHERE user_id = ${session.user.id} AND token_type = 'cli_code'
    `.execute(getDb())
    expect(stored.rows[0]!.payload.provider_tokens.access).toMatch(/^v1:/)

    const exchanged = await auth.exchangeCode(code)
    expect(exchanged.user.id).toBe(session.user.id)
    expect(exchanged.providerTokens?.accessToken).toBe('gho_cli_token')

    await expect(auth.exchangeCode(code)).rejects.toMatchObject({ statusCode: 401 })
    await expect(auth.exchangeCode('otc_nonexistent')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('deleteUser cascades the account and revokes its tokens', async () => {
    const session = await completeOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-${randomUUID()}`,
      email: `del-${randomUUID()}@managed.test`,
      name: null,
      userName: null,
      avatarUrl: null,
    })

    await auth.deleteUser(session.user.id)

    expect(await auth.getUserById(session.user.id)).toBeNull()
    expect(await auth.refreshSession(session.tokens.refreshToken!)).toBeNull()
    const profiles = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.profiles WHERE id = ${session.user.id}
    `.execute(getDb())
    expect(profiles.rows[0]!.count).toBe(0)
  })

  it('refreshProviderToken returns null without OAuth app credentials', async () => {
    expect(await auth.refreshProviderToken('google', 'x')).toBeNull()
    expect(await auth.refreshProviderToken('github', 'ghr_missing_creds')).toBeNull()
  })
})
