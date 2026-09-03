/**
 * Public comment read — the threads of one content entry, for embedding in
 * the site that renders the entry (e.g. the Astro `<cr-component
 * type="comments">` of a migrated WordPress site).
 *
 * Auth: NONE (public endpoint; CORS via 00.public-cors middleware)
 * Rate limit: per-IP sliding window
 * Plan: comments.enabled + comments.models cap
 *
 * GET /api/comments/v1/{projectId}/{modelId}/{entryId}?locale=en&page=1&limit=20&sort=oldest
 *
 * Pagination is over root comments; every approved reply under the page's
 * roots ships with them. Only approved comments are returned and never an
 * email, IP address, user agent or referrer.
 */

import { getClientIp } from '~~/server/utils/form-types'
import { buildCommentTree } from '~~/server/utils/comment-thread'
import { normalizeLocaleParam, resolvePublicCommentContext } from '~~/server/utils/comment-public-context'

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const entryId = getRouterParam(event, 'entryId')

  if (!projectId || !modelId || !entryId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const ip = getClientIp(event)
  const rateCheck = await checkRateLimit(`comments-read:${ip}`, 120, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('comments.rate_limited') })

  const ctx = await resolvePublicCommentContext(projectId, modelId)

  const query = getQuery(event)
  const locale = normalizeLocaleParam(query.locale, ctx.defaultLocale)
  const page = Math.max(1, Number(query.page ?? 1) || 1)
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20) || 20))
  const sort = query.sort === 'newest' ? 'newest' : 'oldest'

  const db = useDatabaseProvider()
  const key = { model_id: modelId, entry_id: entryId, locale }
  const [thread, listing] = await Promise.all([
    db.getCommentThread(projectId, key),
    db.listPublicComments(projectId, key, { page, limit, sort }),
  ])

  const { threads } = buildCommentTree(listing.roots, listing.replies)
  const closed = Boolean(thread?.closed_at)
  const config = useRuntimeConfig()

  return {
    entry: { modelId, entryId, locale },
    config: {
      closed,
      requireApproval: ctx.config.requireApproval,
      requireEmail: ctx.config.requireEmail,
      maxDepth: ctx.config.maxDepth,
      maxBodyLength: ctx.config.maxBodyLength,
      captcha: ctx.config.captcha && hasFeature(ctx.plan, 'comments.captcha') ? 'turnstile' : null,
      captchaSiteKey: ctx.config.captcha && hasFeature(ctx.plan, 'comments.captcha') ? (config.public.turnstileSiteKey || null) : null,
      honeypotField: ctx.config.honeypot ? '_hp' : null,
    },
    comments: threads,
    total: listing.total,
    page,
    limit,
  }
})
