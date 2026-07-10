/**
 * GET /api/auth/oauth/:provider — the managed pair's OAuth dance.
 *
 * Leg 1 (no ?code): stashes flow context (redirect target, CLI port, CSRF
 * state) in a sealed short-lived session cookie, then redirects to the
 * provider's authorize URL.
 * Leg 2 (?code): validates state against the cookie, then delegates the
 * token exchange to the nuxt-auth-utils handler; onSuccess links/creates
 * the user (managed-auth), persists GitHub provider tokens, and either
 * sets the web session cookie or redirects the CLI with a one-time code.
 *
 * 404s on the Supabase pair — GoTrue owns OAuth there.
 */
import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import type { ProviderTokens } from '../../../providers/auth'
import { completeOAuthSignIn, createCliAuthCode } from '../../../providers/managed-auth'

interface OAuthFlowData {
  state: string
  redirect: string
  cliRedirect?: string
  cliState?: string
  createdAt: number
}

const FLOW_COOKIE = 'contentrain-oauth-flow'
const FLOW_MAX_AGE = 60 * 10

async function flowSession(event: H3Event) {
  return useSession<OAuthFlowData>(event, {
    password: useRuntimeConfig().sessionSecret,
    name: FLOW_COOKIE,
    maxAge: FLOW_MAX_AGE,
  })
}

function providerAuthorizeUrl(event: H3Event, provider: 'github' | 'google', state: string): string {
  const config = useRuntimeConfig()
  const oauth = config.oauth as { github?: { clientId?: string }, google?: { clientId?: string } }
  const siteUrl = (config.public.siteUrl as string).replace(/\/+$/, '')
  const redirectUri = `${siteUrl}/api/auth/oauth/${provider}`

  if (provider === 'github') {
    const params = new URLSearchParams({
      client_id: oauth.github?.clientId ?? '',
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
    })
    return `https://github.com/login/oauth/authorize?${params.toString()}`
  }

  const params = new URLSearchParams({
    client_id: oauth.google?.clientId ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

/** Shared success path for both providers. */
async function onSignedIn(event: H3Event, input: {
  provider: 'github' | 'google'
  providerAccountId: string
  email: string | null
  name: string | null
  userName: string | null
  avatarUrl: string | null
  providerTokens: ProviderTokens | null
}) {
  if (!input.email) {
    throw createError({ statusCode: 400, message: errorMessage('auth.email_required') })
  }

  const session = await completeOAuthSignIn({
    provider: input.provider,
    providerAccountId: input.providerAccountId,
    email: input.email,
    name: input.name,
    userName: input.userName,
    avatarUrl: input.avatarUrl,
  })

  // Persist GitHub user-to-server tokens for installation APIs — this route
  // is the only capture window on the managed pair (web never hits /verify).
  if (input.provider === 'github' && input.providerTokens?.accessToken) {
    try {
      await useDatabaseProvider().upsertOAuthProviderToken({
        userId: session.user.id,
        provider: 'github',
        accessToken: input.providerTokens.accessToken,
        refreshToken: input.providerTokens.refreshToken,
        expiresAt: input.providerTokens.expiresAt,
        refreshTokenExpiresAt: input.providerTokens.refreshTokenExpiresAt,
      })
    }
    catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn('[auth] failed to persist GitHub provider token:', err instanceof Error ? err.message : err)
    }
  }

  const flow = await flowSession(event)
  const { redirect = '/', cliRedirect, cliState } = flow.data ?? {}
  await flow.clear()

  if (cliRedirect) {
    const code = await createCliAuthCode(session.user, input.providerTokens)
    const target = new URL(cliRedirect)
    target.searchParams.set('code', code)
    if (cliState) target.searchParams.set('state', cliState)
    return sendRedirect(event, target.toString())
  }

  await setServerSession(event, {
    userId: session.user.id,
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    expiresAt: session.tokens.expiresAt,
  })

  // Client callback page finishes by fetching /api/auth/me — the cookie is
  // already set, so a plain redirect (no tokens in the URL, ever) suffices.
  return sendRedirect(event, redirect.startsWith('/') ? redirect : '/')
}

function toUnixOrNull(expiresIn: unknown): number | null {
  return typeof expiresIn === 'number' ? Math.floor(Date.now() / 1000) + expiresIn : null
}

// Handlers are built lazily so redirectURL can come from runtime config:
// behind Railway's proxy the module would otherwise derive the exchange
// redirect_uri from the request URL (http://…), mismatching the https
// authorize leg — GitHub rejects the token exchange on that mismatch.
let _githubHandler: ReturnType<typeof defineOAuthGitHubEventHandler> | null = null
let _googleHandler: ReturnType<typeof defineOAuthGoogleEventHandler> | null = null

function oauthHandlers() {
  if (_githubHandler && _googleHandler)
    return { github: _githubHandler, google: _googleHandler }

  const siteUrl = (useRuntimeConfig().public.siteUrl as string).replace(/\/+$/, '')

  _githubHandler = defineOAuthGitHubEventHandler({
    config: { emailRequired: true, redirectURL: `${siteUrl}/api/auth/oauth/github` },
    async onSuccess(event, { user, tokens }) {
      // GitHubTokens doesn't type the refresh fields — classic OAuth Apps never
      // send them, GitHub Apps with expiring user tokens do. Read them loosely.
      const t = tokens as { access_token?: string, refresh_token?: string | null, expires_in?: number, refresh_token_expires_in?: number }

      return onSignedIn(event, {
        provider: 'github',
        providerAccountId: String(user.id),
        email: user.email ?? null,
        name: user.name ?? null,
        userName: user.login ?? null,
        avatarUrl: user.avatar_url ?? null,
        providerTokens: t?.access_token
          ? {
              accessToken: t.access_token,
              refreshToken: t.refresh_token ?? null,
              expiresAt: toUnixOrNull(t.expires_in),
              refreshTokenExpiresAt: toUnixOrNull(t.refresh_token_expires_in),
            }
          : null,
      })
    },
    onError(event, error) {
      // eslint-disable-next-line no-console
      console.warn('[auth] github oauth failed:', error instanceof Error ? error.message : error)
      return sendRedirect(event, '/auth/login?error=oauth')
    },
  })

  _googleHandler = defineOAuthGoogleEventHandler({
    config: { redirectURL: `${siteUrl}/api/auth/oauth/google` },
    async onSuccess(event, { user }) {
      return onSignedIn(event, {
        provider: 'google',
        providerAccountId: String(user.sub),
        email: user.email ?? null,
        name: user.name ?? null,
        userName: null,
        avatarUrl: user.picture ?? null,
        providerTokens: null, // Google tokens are not persisted (parity with the Supabase pair)
      })
    },
    onError(event, error) {
      // eslint-disable-next-line no-console
      console.warn('[auth] google oauth failed:', error instanceof Error ? error.message : error)
      return sendRedirect(event, '/auth/login?error=oauth')
    },
  })

  return { github: _githubHandler, google: _googleHandler }
}

export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const provider = getRouterParam(event, 'provider')
  if (provider !== 'github' && provider !== 'google') {
    throw createError({ statusCode: 400, message: errorMessage('auth.invalid_provider') })
  }

  const query = getQuery(event) as { code?: string, state?: string, redirect?: string, cli_redirect?: string, cli_state?: string }

  // ── Leg 1: start the dance ──
  if (!query.code) {
    const state = query.state || randomBytes(16).toString('hex')
    const flow = await flowSession(event)
    await flow.update({
      state,
      redirect: query.redirect || '/',
      cliRedirect: query.cli_redirect,
      cliState: query.cli_state,
      createdAt: Date.now(),
    })
    return sendRedirect(event, providerAuthorizeUrl(event, provider, state))
  }

  // ── Leg 2: provider callback — CSRF check, then exchange ──
  const flow = await flowSession(event)
  const expected = flow.data?.state
  if (!expected || !query.state || expected !== query.state) {
    await flow.clear()
    throw createError({ statusCode: 403, message: errorMessage('auth.invalid_state') })
  }

  const handlers = oauthHandlers()
  return provider === 'github' ? handlers.github(event) : handlers.google(event)
})
