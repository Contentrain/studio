/**
 * GET /api/auth/magic/verify?token=mlc_…&redirect=/
 *
 * Managed-pair magic-link / invite landing: consumes the single-use token
 * server-side, sets the session cookie, and redirects into the app. A
 * server-side GET (instead of the client posting to /verify) keeps the flow
 * working across browsers/devices — an email click carries no CSRF-state
 * cookie, and no token ever appears in a client-visible URL beyond this
 * one-shot, 1-hour, single-use code.
 *
 * 404s on the Supabase pair — GoTrue owns magic links there.
 */
export default defineEventHandler(async (event) => {
  if (useRuntimeConfig().authProvider !== 'managed') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const ip = getClientIp(event)
  const rateCheck = await checkRateLimit(`magic-verify:${ip}`, 10, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })

  const query = getQuery(event) as { token?: string, redirect?: string }
  if (!query.token)
    return sendRedirect(event, '/auth/login?error=magic-link')

  const { consumeMagicLinkToken } = await import('../../../providers/managed-auth')
  const session = await consumeMagicLinkToken(query.token)

  if (!session)
    return sendRedirect(event, '/auth/login?error=magic-link')

  await setServerSession(event, {
    userId: session.user.id,
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    expiresAt: session.tokens.expiresAt,
  })

  return sendRedirect(event, internalRedirect(query.redirect))
})

/**
 * Invite links carry an absolute `{siteUrl}/auth/callback?workspace=…`
 * target (the Supabase pair's GoTrue needs one), magic links a path. Keep
 * both, but only ever redirect within this site — same-origin URLs collapse
 * to their path, anything else (other origins, `//host`) falls back to `/`.
 */
function internalRedirect(target: string | undefined): string {
  if (!target) return '/'
  if (target.startsWith('/'))
    return target.startsWith('//') || target.startsWith('/\\') ? '/' : target

  try {
    const siteOrigin = new URL(useRuntimeConfig().public.siteUrl as string).origin
    const url = new URL(target)
    return url.origin === siteOrigin ? `${url.pathname}${url.search}${url.hash}` : '/'
  }
  catch {
    return '/'
  }
}
