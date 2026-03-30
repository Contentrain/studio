/**
 * Send a test ping event to a webhook URL.
 * Returns the delivery result (status code, success).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const webhookId = getRouterParam(event, 'webhookId')

  if (!workspaceId || !projectId || !webhookId)
    throw createError({ statusCode: 400, message: errorMessage('webhook.id_required') })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Rate limit test endpoint (prevent DDoS amplification)
  const rateCheck = checkRateLimit(`webhook-test:${webhookId}`, 5, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('rate.limit_exceeded') })

  // Plan check
  const { data: workspace } = await client
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'api.webhooks_outbound'))
    throw createError({ statusCode: 403, message: errorMessage('webhook.upgrade_required') })

  // Fetch the webhook — verify ownership
  const { data: webhook } = await client
    .from('webhooks')
    .select('id, url, secret, active')
    .eq('id', webhookId)
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!webhook)
    throw createError({ statusCode: 404, message: errorMessage('webhook.not_found') })

  // Build test ping payload
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
      if (responseBody && responseBody.length > 1000) {
        responseBody = responseBody.substring(0, 1000)
      }
    }
    catch { /* ignore body read errors */ }

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
})
