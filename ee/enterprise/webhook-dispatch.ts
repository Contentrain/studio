import type { DatabaseProvider } from '../../server/providers/database'
import { useDatabaseProvider } from '../../server/utils/providers'
import { getWorkspacePlan, hasFeature } from '../../server/utils/license'
import { isAllowedWebhookUrl, signPayload } from '../../server/utils/webhook-engine'

type WebhookEvent = string

interface WebhookPayload {
  event: WebhookEvent
  projectId: string
  timestamp: string
  data: Record<string, unknown>
}

interface WebhookRow {
  id: string
  url: string
  events: string[]
  secret: string
  active: boolean
}

const MAX_RETRIES = 5
const RETRY_DELAYS_MS = [
  60_000,
  300_000,
  1_800_000,
  7_200_000,
  43_200_000,
]
const DELIVERY_TIMEOUT_MS = 10_000
type AdminClient = ReturnType<DatabaseProvider['getAdminClient']>

export async function emitWebhookEvent(
  projectId: string,
  workspaceId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const admin = useDatabaseProvider().getAdminClient()

  const { data: workspace } = await admin
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  if (!workspace || !hasFeature(getWorkspacePlan(workspace), 'api.webhooks_outbound'))
    return

  const { data: webhooks } = await admin
    .from('webhooks')
    .select('id, url, events, secret, active')
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('active', true)

  if (!Array.isArray(webhooks) || webhooks.length === 0)
    return

  const matchingWebhooks = webhooks.filter((webhook: WebhookRow) =>
    webhook.events.includes(event) || webhook.events.includes('*'),
  )

  if (matchingWebhooks.length === 0)
    return

  const payload: WebhookPayload = {
    event,
    projectId,
    timestamp: new Date().toISOString(),
    data,
  }

  for (const webhook of matchingWebhooks as WebhookRow[]) {
    if (!isAllowedWebhookUrl(webhook.url))
      continue

    try {
      const { data: delivery } = await admin
        .from('webhook_deliveries')
        .insert({
          webhook_id: webhook.id,
          event,
          payload,
          status: 'pending',
        })
        .select('id')
        .single()

      if (delivery?.id) {
        void attemptDelivery(admin, webhook, payload, delivery.id, 0)
      }
    }
    catch {
      // eslint-disable-next-line no-console
      console.error(`[webhook] Failed to create delivery for webhook ${webhook.id}`)
    }
  }
}

export async function processWebhookRetries(): Promise<number> {
  const admin = useDatabaseProvider().getAdminClient()

  const { data: pendingDeliveries } = await admin
    .from('webhook_deliveries')
    .select('id, webhook_id, payload, retry_count')
    .eq('status', 'pending')
    .lte('next_retry_at', new Date().toISOString())
    .limit(50)

  if (!Array.isArray(pendingDeliveries) || pendingDeliveries.length === 0)
    return 0

  let processed = 0

  for (const delivery of pendingDeliveries) {
    const retryCount = Number(delivery.retry_count ?? 0)
    if (retryCount >= MAX_RETRIES) {
      await admin.from('webhook_deliveries').update({ status: 'failed' }).eq('id', delivery.id)
      processed++
      continue
    }

    const { data: webhook } = await admin
      .from('webhooks')
      .select('id, url, events, secret, active')
      .eq('id', delivery.webhook_id)
      .eq('active', true)
      .single()

    if (!webhook || !isAllowedWebhookUrl(String(webhook.url))) {
      await admin.from('webhook_deliveries').update({ status: 'failed' }).eq('id', delivery.id)
      processed++
      continue
    }

    await attemptDelivery(admin, webhook as unknown as WebhookRow, delivery.payload as WebhookPayload, String(delivery.id), retryCount)
    processed++
  }

  return processed
}

async function attemptDelivery(
  admin: AdminClient,
  webhook: WebhookRow,
  payload: WebhookPayload,
  deliveryId: string,
  retryCount: number,
): Promise<boolean> {
  const body = JSON.stringify(payload)
  const signature = signPayload(body, webhook.secret)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Contentrain-Signature': signature,
        'X-Contentrain-Event': payload.event,
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
    catch {
      responseBody = null
    }

    if (success) {
      await admin.from('webhook_deliveries').update({
        status: 'delivered',
        response_code: response.status,
        response_body: responseBody,
        delivered_at: new Date().toISOString(),
      }).eq('id', deliveryId)
    }
    else {
      const nextDelay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]!
      await admin.from('webhook_deliveries').update({
        status: 'pending',
        response_code: response.status,
        response_body: responseBody,
        retry_count: retryCount + 1,
        next_retry_at: new Date(Date.now() + nextDelay).toISOString(),
      }).eq('id', deliveryId)
    }

    return success
  }
  catch {
    const nextDelay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]!
    await admin.from('webhook_deliveries').update({
      status: 'pending',
      retry_count: retryCount + 1,
      next_retry_at: new Date(Date.now() + nextDelay).toISOString(),
    }).eq('id', deliveryId)
    return false
  }
}
