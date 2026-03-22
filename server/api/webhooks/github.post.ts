/**
 * GitHub webhook handler.
 *
 * Validates HMAC-SHA256 signature, then processes:
 * - push → update projects.content_updated_at
 * - installation → update workspace github_installation_id
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export default defineEventHandler(async (event) => {
  const runtimeConfig = useRuntimeConfig()
  const secret = runtimeConfig.github.webhookSecret

  if (!secret)
    throw createError({ statusCode: 500, message: 'Webhook secret not configured' })

  // Verify HMAC-SHA256 signature
  const signature = getHeader(event, 'x-hub-signature-256')
  if (!signature)
    throw createError({ statusCode: 401, message: 'Missing signature' })

  const rawBody = await readRawBody(event)
  if (!rawBody)
    throw createError({ statusCode: 400, message: 'Empty body' })

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`

  const sigBuf = Buffer.from(signature)
  const expectedBuf = Buffer.from(expected)

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf))
    throw createError({ statusCode: 401, message: 'Invalid signature' })

  const body = JSON.parse(rawBody) as Record<string, unknown>
  const eventType = getHeader(event, 'x-github-event')

  const admin = useSupabaseAdmin()

  if (eventType === 'push') {
    const repoFullName = (body.repository as { full_name?: string })?.full_name
    if (!repoFullName) return { ok: true }

    await admin
      .from('projects')
      .update({ content_updated_at: new Date().toISOString() })
      .eq('repo_full_name', repoFullName)

    return { ok: true, event: 'push', repo: repoFullName }
  }

  if (eventType === 'installation') {
    const action = body.action as string
    const installationId = (body.installation as { id?: number })?.id

    if (action === 'deleted' && installationId) {
      // Clear installation from workspaces
      await admin
        .from('workspaces')
        .update({ github_installation_id: null })
        .eq('github_installation_id', installationId)

      return { ok: true, event: 'installation', action: 'deleted' }
    }

    return { ok: true, event: 'installation', action }
  }

  return { ok: true, event: eventType }
})
