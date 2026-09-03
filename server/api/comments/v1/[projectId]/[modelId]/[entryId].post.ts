/**
 * Public comment submit — a visitor posts a comment (or a reply) on one
 * content entry from the site that renders it.
 *
 * Auth: NONE (public endpoint; CORS via 00.public-cors middleware)
 * Rate limit: per-IP + entry sliding window (model config `rateLimitPerIp`)
 * Plan: comments.enabled + comments.models cap + comments.per_month quota
 * Security: honeypot, Turnstile (comments.captcha), length + URL validation,
 *           HTML sanitization; thread-closed, parent and depth checks run
 *           atomically inside `create_comment_if_allowed`.
 *
 * POST /api/comments/v1/{projectId}/{modelId}/{entryId}?locale=en
 * body { author: { name, email?, url? }, body, parentId?, captchaToken?, _hp? }
 */

import { getClientIp } from '~~/server/utils/form-types'
import { toPublicComment } from '~~/server/utils/comment-thread'
import { normalizeLocaleParam, resolvePublicCommentContext } from '~~/server/utils/comment-public-context'
import { sanitizeString } from '~~/server/utils/sanitize-input'
import { verifyTurnstileToken } from '~~/server/utils/turnstile'
import { getEffectiveLimit } from '~~/server/utils/overage'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SubmitBody {
  author?: { name?: unknown, email?: unknown, url?: unknown }
  body?: unknown
  parentId?: unknown
  captchaToken?: unknown
  _hp?: unknown
}

function fieldError(field: string, key: string) {
  return { success: false as const, errors: [{ field, message: errorMessage(key) }] }
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString().slice(0, 2048)
  }
  catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const entryId = getRouterParam(event, 'entryId')

  if (!projectId || !modelId || !entryId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  const ip = getClientIp(event)

  const body = await readBody<SubmitBody>(event)
  if (!body || typeof body !== 'object')
    throw createError({ statusCode: 400, message: errorMessage('comments.body_required') })

  const ctx = await resolvePublicCommentContext(projectId, modelId)
  const locale = normalizeLocaleParam(getQuery(event).locale)

  // Rate limit per IP + entry (model config, default 5/min)
  const rateCheck = await checkRateLimit(`comment:${ip}:${projectId}:${modelId}:${entryId}`, ctx.config.rateLimitPerIp, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('comments.rate_limited') })

  // Honeypot — silent accept so bots learn nothing
  if (ctx.config.honeypot && typeof body._hp === 'string' && body._hp.length > 0)
    return { success: true, status: 'pending' }

  // Captcha (plan + config)
  if (ctx.config.captcha === 'turnstile' && hasFeature(ctx.plan, 'comments.captcha')) {
    if (typeof body.captchaToken !== 'string' || !body.captchaToken)
      return fieldError('captcha', 'comments.captcha_failed')
    const valid = await verifyTurnstileToken(body.captchaToken, ip)
    if (!valid)
      return fieldError('captcha', 'comments.captcha_failed')
  }

  // Author
  const authorName = typeof body.author?.name === 'string' ? sanitizeString(body.author.name).trim().slice(0, 120) : ''
  if (!authorName)
    return fieldError('author.name', 'comments.author_required')

  let authorEmail: string | null = null
  if (typeof body.author?.email === 'string' && body.author.email.trim()) {
    const email = body.author.email.trim().toLowerCase()
    if (!EMAIL_RE.test(email) || email.length > 254)
      return fieldError('author.email', 'comments.email_invalid')
    authorEmail = email
  }
  else if (ctx.config.requireEmail) {
    return fieldError('author.email', 'comments.email_required')
  }

  let authorUrl: string | null = null
  if (typeof body.author?.url === 'string' && body.author.url.trim()) {
    authorUrl = normalizeUrl(body.author.url)
    if (!authorUrl)
      return fieldError('author.url', 'comments.url_invalid')
  }

  // Body
  const text = typeof body.body === 'string' ? sanitizeString(body.body).trim() : ''
  if (!text)
    return fieldError('body', 'comments.body_required')
  if (text.length > ctx.config.maxBodyLength)
    return fieldError('body', 'comments.body_too_long')

  // Parent
  let parentId: string | null = null
  if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '') {
    if (typeof body.parentId !== 'string' || !UUID_RE.test(body.parentId))
      return fieldError('parentId', 'comments.parent_not_found')
    parentId = body.parentId
  }

  const autoApprove = !ctx.config.requireApproval && hasFeature(ctx.plan, 'comments.auto_approve')
  const status = autoApprove ? 'approved' : 'pending'

  const basePlanLimit = getPlanLimit(ctx.plan, 'comments.per_month')
  const overageSettings = ctx.workspace.overage_settings as Record<string, boolean> | null
  const monthlyLimit = getEffectiveLimit(basePlanLimit, 'comments.per_month', overageSettings)

  const db = useDatabaseProvider()
  const outcome = await db.createCommentIfAllowed(ctx.workspaceId, monthlyLimit, {
    project_id: projectId,
    workspace_id: ctx.workspaceId,
    model_id: modelId,
    entry_id: entryId,
    locale,
    parent_id: parentId,
    max_depth: ctx.config.maxDepth,
    author_name: authorName,
    author_email: authorEmail,
    author_url: authorUrl,
    body: text,
    status,
    source_ip: ip !== 'unknown' ? ip : undefined,
    user_agent: getHeader(event, 'user-agent') ?? undefined,
    referrer: getHeader(event, 'referer') ?? getHeader(event, 'referrer') ?? undefined,
  })

  if (!outcome.allowed) {
    switch (outcome.reason) {
      case 'thread_closed':
        throw createError({ statusCode: 403, message: errorMessage('comments.thread_closed') })
      case 'parent_not_found':
        return fieldError('parentId', 'comments.parent_not_found')
      case 'depth_exceeded':
        return fieldError('parentId', 'comments.depth_exceeded')
      case 'monthly_limit':
      default:
        throw createError({ statusCode: 429, message: errorMessage('comments.monthly_limit') })
    }
  }

  if (!outcome.comment)
    throw createError({ statusCode: 500, message: errorMessage('comments.create_failed', { detail: 'empty' }) })

  // Outbound webhook — gated exactly like forms.webhook_notification (ee).
  if (hasFeature(ctx.plan, 'comments.webhook_notification')) {
    emitWebhookEvent(projectId, ctx.workspaceId, 'comment.submitted', {
      commentId: outcome.comment.id,
      modelId,
      entryId,
      locale,
      parentId,
      status,
    }).catch(() => {})
  }

  return {
    success: true,
    status,
    // Approved comments render immediately; pending ones only echo back to the author.
    comment: toPublicComment(outcome.comment),
  }
})
