/**
 * POST /api/auth/review-login — directory-review password login.
 *
 * Claude/OpenAI reviewers need credentials that work without OAuth, MFA or
 * email confirmation (OpenAI rejects all three). This surface exists ONLY
 * when the operator opts in via env and accepts exactly ONE address:
 *
 *   NUXT_REVIEW_ACCOUNT_EMAIL    — the single allowed email
 *   NUXT_REVIEW_ACCOUNT_PASSWORD — min 16 chars (boot-validated)
 *
 * Unset (the default everywhere, including production until a review
 * cycle starts) → 404, indistinguishable from a nonexistent route. The
 * comparison is timing-safe over SHA-256 digests, per-IP rate limited,
 * and managed-pair only. The user materializes through the same email
 * bootstrap chain as a magic-link signup.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readBody } from 'h3'
import { createReviewSession } from '~~/server/providers/managed-auth'
import { errorMessage } from '~~/server/utils/content-strings'
import { checkRateLimit } from '~~/server/utils/rate-limit'

function digestEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  )
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const review = config.reviewAccount as { email?: string, password?: string } | undefined

  if (config.authProvider !== 'managed' || !review?.email || !review.password || review.password.length < 16) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const ip = getClientIp(event)
  const rateCheck = await checkRateLimit(`review-login:${ip}`, 5, 60_000)
  if (!rateCheck.allowed) {
    throw createError({ statusCode: 429, message: errorMessage('auth.rate_limited') })
  }

  const body = await readBody<{ email?: string, password?: string }>(event).catch(() => null)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  const emailOk = email.length > 0 && digestEquals(email.toLowerCase(), review.email.trim().toLowerCase())
  const passwordOk = password.length > 0 && digestEquals(password, review.password)
  if (!emailOk || !passwordOk) {
    throw createError({ statusCode: 401, message: errorMessage('auth.review_login_invalid') })
  }

  const session = await createReviewSession(review.email.trim())

  await setServerSession(event, {
    userId: session.user.id,
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    expiresAt: session.tokens.expiresAt,
  })

  return { ok: true }
})
