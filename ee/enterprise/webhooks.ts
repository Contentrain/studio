import { createError, getQuery, getRouterParam, readBody, type H3Event } from 'h3'
import { randomBytes } from 'node:crypto'
import { requireAuth } from '../../server/utils/auth'
import { errorMessage } from '../../server/utils/content-strings'
import { getWorkspacePlan, hasFeature, getPlanLimit } from '../../server/utils/license'
import { useDatabaseProvider } from '../../server/utils/providers'
import { checkRateLimit } from '../../server/utils/rate-limit'
import { isAllowedWebhookUrl, signPayload } from '../../server/utils/webhook-engine'

export function createWebhooksBridge() {
  return {
    async listProjectWebhooks(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')

      if (!workspaceId || !projectId)
        throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      const workspace = await db.getWorkspaceById(workspaceId, 'plan')
      if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'api.webhooks_outbound'))
        throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

      const admin = db.getAdminClient()
      const { data } = await admin
        .from('webhooks')
        .select('id, name, url, events, active, created_at, updated_at, secret')
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })

      return (data ?? []).map((w: { secret: string, [key: string]: unknown }) => ({
        ...w,
        secret: w.secret ? `****${w.secret.slice(-4)}` : null,
      }))
    },

    async createProjectWebhook(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')
      const body = await readBody<{ name: string, url: string, events: string[] }>(event)

      if (!workspaceId || !projectId)
        throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

      if (!body.name?.trim())
        throw createError({ statusCode: 400, message: errorMessage('webhook.name_required') })

      if (!body.url?.trim())
        throw createError({ statusCode: 400, message: errorMessage('webhook.url_required') })

      if (!body.events?.length)
        throw createError({ statusCode: 400, message: errorMessage('webhook.events_required') })

      if (!isAllowedWebhookUrl(body.url))
        throw createError({ statusCode: 400, message: errorMessage('webhook.url_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')
      if (!project)
        throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

      const workspace = await db.getWorkspaceById(workspaceId, 'plan')
      const plan = getWorkspacePlan(workspace ?? {})
      if (!hasFeature(plan, 'api.webhooks_outbound'))
        throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

      const webhookLimit = getPlanLimit(plan, 'api.webhooks')
      const count = await db.countProjectWebhooks(projectId, workspaceId)
      if (count >= webhookLimit)
        throw createError({ statusCode: 403, message: errorMessage('webhook.limit_reached', { limit: webhookLimit }) })

      const secret = randomBytes(32).toString('hex')
      const data = await db.createWebhook({
        workspaceId,
        projectId,
        name: body.name.trim(),
        url: body.url.trim(),
        events: body.events,
        secret,
      })

      return { ...data, secret }
    },

    async updateProjectWebhook(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')
      const webhookId = getRouterParam(event, 'webhookId')
      const body = await readBody<{ name?: string, url?: string, events?: string[], active?: boolean }>(event)

      if (!workspaceId || !projectId || !webhookId)
        throw createError({ statusCode: 400, message: errorMessage('webhook.id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      const workspace = await db.getWorkspaceById(workspaceId, 'plan')
      if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'api.webhooks_outbound'))
        throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

      if (body.url !== undefined && !isAllowedWebhookUrl(body.url))
        throw createError({ statusCode: 400, message: errorMessage('webhook.url_required') })

      const update: Record<string, unknown> = {}
      if (body.name !== undefined) update.name = body.name.trim()
      if (body.url !== undefined) update.url = body.url.trim()
      if (body.events !== undefined) update.events = body.events
      if (body.active !== undefined) update.active = body.active
      update.updated_at = new Date().toISOString()

      if (Object.keys(update).length <= 1)
        throw createError({ statusCode: 400, message: errorMessage('validation.no_fields_to_update') })

      const admin = db.getAdminClient()
      const { data, error } = await admin
        .from('webhooks')
        .update(update)
        .eq('id', webhookId)
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .select('id, name, url, events, active, created_at, updated_at')
        .single()

      if (error)
        throw createError({ statusCode: 500, message: error.message })

      if (!data)
        throw createError({ statusCode: 404, message: errorMessage('webhook.not_found') })

      return data
    },

    async deleteProjectWebhook(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')
      const webhookId = getRouterParam(event, 'webhookId')

      if (!workspaceId || !projectId || !webhookId)
        throw createError({ statusCode: 400, message: errorMessage('webhook.id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      const admin = db.getAdminClient()
      await admin.from('webhook_deliveries').delete().eq('webhook_id', webhookId)

      const { error } = await admin
        .from('webhooks')
        .delete()
        .eq('id', webhookId)
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)

      if (error)
        throw createError({ statusCode: 500, message: error.message })

      return { deleted: true }
    },

    async testProjectWebhook(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')
      const webhookId = getRouterParam(event, 'webhookId')

      if (!workspaceId || !projectId || !webhookId)
        throw createError({ statusCode: 400, message: errorMessage('webhook.id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      const rateCheck = checkRateLimit(`webhook-test:${webhookId}`, 5, 60_000)
      if (!rateCheck.allowed)
        throw createError({ statusCode: 429, message: errorMessage('rate.limit_exceeded') })

      const workspace = await db.getWorkspaceById(workspaceId, 'plan')
      if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'api.webhooks_outbound'))
        throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

      const admin = db.getAdminClient()
      const { data: webhook } = await admin
        .from('webhooks')
        .select('id, url, secret, active')
        .eq('id', webhookId)
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .single()

      if (!webhook)
        throw createError({ statusCode: 404, message: errorMessage('webhook.not_found') })

      const payload = {
        event: 'ping' as const,
        projectId,
        timestamp: new Date().toISOString(),
        data: {
          message: 'Webhook test ping from Contentrain Studio',
          webhookId: webhook.id,
        },
      }

      const body = JSON.stringify(payload)
      const signature = signPayload(body, webhook.secret)

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)

        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Contentrain-Signature': signature,
            'X-Contentrain-Event': 'ping',
            'User-Agent': 'Contentrain-Webhook/1.0',
          },
          body,
          signal: controller.signal,
        })

        clearTimeout(timeout)

        const success = response.status >= 200 && response.status < 300
        let responseBody: string | null = null
        try {
          responseBody = await response.text()
          if (responseBody && responseBody.length > 1000)
            responseBody = responseBody.substring(0, 1000)
        }
        catch (err) {
          // eslint-disable-next-line no-console
          console.error('[webhook-test] Failed to read response body:', err)
        }

        return {
          success,
          statusCode: response.status,
          responseBody,
        }
      }
      catch {
        return {
          success: false,
          statusCode: null,
          responseBody: null,
          error: errorMessage('webhook.delivery_failed'),
        }
      }
    },

    async listWebhookDeliveries(event: H3Event) {
      const session = requireAuth(event)
      const db = useDatabaseProvider()
      const workspaceId = getRouterParam(event, 'workspaceId')
      const projectId = getRouterParam(event, 'projectId')
      const webhookId = getRouterParam(event, 'webhookId')

      if (!workspaceId || !projectId || !webhookId)
        throw createError({ statusCode: 400, message: errorMessage('webhook.id_required') })

      await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

      const workspace = await db.getWorkspaceById(workspaceId, 'plan')
      if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'api.webhooks_outbound'))
        throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

      const admin = db.getAdminClient()
      const { data: webhook } = await admin
        .from('webhooks')
        .select('id')
        .eq('id', webhookId)
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)
        .single()

      if (!webhook)
        throw createError({ statusCode: 404, message: errorMessage('webhook.not_found') })

      const query = getQuery(event)
      const page = Math.max(1, Number(query.page) || 1)
      const limit = Math.min(Number(query.limit) || 50, 100)
      const offset = (page - 1) * limit

      const { data, count, error } = await admin
        .from('webhook_deliveries')
        .select('id, event, status, response_code, response_body, retry_count, delivered_at, next_retry_at, created_at', { count: 'exact' })
        .eq('webhook_id', webhookId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error)
        throw createError({ statusCode: 500, message: error.message })

      return {
        deliveries: data ?? [],
        total: count ?? 0,
        page,
        limit,
      }
    },
  }
}
