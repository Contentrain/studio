/**
 * Webhook outbound engine — event emission + async delivery.
 *
 * Events are emitted after content operations (save, delete, merge, etc.)
 * and delivered asynchronously to registered webhook URLs.
 *
 * Security: HMAC-SHA256 signature in X-Contentrain-Signature header.
 * Retry: exponential backoff — 1m, 5m, 30m, 2h, 12h (max 5 retries).
 *
 * Plan: Business+ (api.webhooks_outbound feature flag)
 */

import { createHmac } from 'node:crypto'

// ─── Types ───

export type WebhookEvent
  = | 'content.saved'
    | 'content.deleted'
    | 'model.saved'
    | 'branch.merged'
    | 'branch.rejected'
    | 'cdn.build_complete'
    | 'media.uploaded'
    | 'form.submitted'

export interface WebhookPayload {
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

// ─── Constants ───

const MAX_RETRIES = 5
const RETRY_DELAYS_MS = [
  60_000, // 1 min
  300_000, // 5 min
  1_800_000, // 30 min
  7_200_000, // 2 hours
  43_200_000, // 12 hours
]
const DELIVERY_TIMEOUT_MS = 10_000

// ─── Signature ───

/** Generate HMAC-SHA256 signature for webhook payload. */
export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/** Verify HMAC-SHA256 signature. */
export function verifySignature(payload: string, secret: string, signature: string): boolean {
  const expected = signPayload(payload, secret)
  // Timing-safe comparison
  if (expected.length !== signature.length) return false
  let result = 0
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return result === 0
}

// ─── Event Emission ───

/**
 * Emit a webhook event for a project.
 * Creates delivery records for all matching active webhooks.
 * Delivery happens asynchronously (fire-and-forget from caller's perspective).
 */
export async function emitWebhookEvent(
  projectId: string,
  workspaceId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const admin = useSupabaseAdmin()

  // Check workspace plan
  const { data: workspace } = await admin
    .from('workspaces')
    .select('plan')
    .eq('id', workspaceId)
    .single()

  if (!workspace || !hasFeature(getWorkspacePlan(workspace), 'api.webhooks_outbound')) return

  // Find matching active webhooks
  const { data: webhooks } = await admin
    .from('webhooks')
    .select('id, url, events, secret, active')
    .eq('project_id', projectId)
    .eq('active', true)

  if (!webhooks?.length) return

  const matchingWebhooks = webhooks.filter((w: WebhookRow) =>
    w.events.includes(event) || w.events.includes('*'),
  )

  if (matchingWebhooks.length === 0) return

  const payload: WebhookPayload = {
    event,
    projectId,
    timestamp: new Date().toISOString(),
    data,
  }

  // Create delivery records + attempt immediate delivery
  for (const webhook of matchingWebhooks as WebhookRow[]) {
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

      if (delivery) {
        // Fire-and-forget: attempt delivery, update status async
        deliverWebhook(webhook, payload, delivery.id).catch(() => {
          // Delivery failed — will be picked up by retry processor
        })
      }
    }
    catch {
      // eslint-disable-next-line no-console
      console.error(`[webhook] Failed to create delivery for webhook ${webhook.id}`)
    }
  }
}

// ─── Delivery ───

/**
 * Attempt to deliver a webhook payload to the target URL.
 * Updates delivery record with status and response info.
 */
async function deliverWebhook(
  webhook: WebhookRow,
  payload: WebhookPayload,
  deliveryId: string,
): Promise<boolean> {
  const admin = useSupabaseAdmin()
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
      if (responseBody && responseBody.length > 1000) {
        responseBody = responseBody.substring(0, 1000)
      }
    }
    catch { /* ignore body read errors */ }

    await admin
      .from('webhook_deliveries')
      .update({
        status: success ? 'delivered' : 'pending',
        response_code: response.status,
        response_body: responseBody,
        delivered_at: success ? new Date().toISOString() : null,
        retry_count: success ? undefined : 1,
        next_retry_at: success ? null : new Date(Date.now() + RETRY_DELAYS_MS[0]!).toISOString(),
      })
      .eq('id', deliveryId)

    return success
  }
  catch {
    // Network error, timeout, etc.
    await admin
      .from('webhook_deliveries')
      .update({
        status: 'pending',
        retry_count: 1,
        next_retry_at: new Date(Date.now() + RETRY_DELAYS_MS[0]!).toISOString(),
      })
      .eq('id', deliveryId)

    return false
  }
}

/**
 * Process pending webhook retries.
 * Called periodically (e.g. every 60s via cron or server interval).
 */
export async function processWebhookRetries(): Promise<number> {
  const admin = useSupabaseAdmin()

  const { data: pendingDeliveries } = await admin
    .from('webhook_deliveries')
    .select('id, webhook_id, payload, retry_count')
    .eq('status', 'pending')
    .lte('next_retry_at', new Date().toISOString())
    .limit(50)

  if (!pendingDeliveries?.length) return 0

  let processed = 0
  for (const delivery of pendingDeliveries) {
    const { data: webhook } = await admin
      .from('webhooks')
      .select('id, url, events, secret, active')
      .eq('id', delivery.webhook_id)
      .eq('active', true)
      .single()

    if (!webhook) {
      // Webhook deleted or disabled — mark failed
      await admin
        .from('webhook_deliveries')
        .update({ status: 'failed' })
        .eq('id', delivery.id)
      processed++
      continue
    }

    const retryCount = delivery.retry_count ?? 0
    if (retryCount >= MAX_RETRIES) {
      await admin
        .from('webhook_deliveries')
        .update({ status: 'failed' })
        .eq('id', delivery.id)
      processed++
      continue
    }

    const success = await deliverWebhook(
      webhook as WebhookRow,
      delivery.payload as WebhookPayload,
      delivery.id,
    )

    if (!success) {
      const nextRetryDelay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)]!
      await admin
        .from('webhook_deliveries')
        .update({
          retry_count: retryCount + 1,
          next_retry_at: new Date(Date.now() + nextRetryDelay).toISOString(),
        })
        .eq('id', delivery.id)
    }

    processed++
  }

  return processed
}
