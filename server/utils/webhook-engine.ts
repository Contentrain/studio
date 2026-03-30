/**
 * Webhook outbound engine — event emission + async delivery.
 *
 * Security: HMAC-SHA256 signature, SSRF protection, timing-safe verify.
 * Retry: exponential backoff — 1m, 5m, 30m, 2h, 12h (max 5 retries).
 *
 * Plan: Business+ (api.webhooks_outbound feature flag)
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

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

export const VALID_WEBHOOK_EVENTS: ReadonlySet<string> = new Set<WebhookEvent>([
  'content.saved', 'content.deleted', 'model.saved',
  'branch.merged', 'branch.rejected', 'cdn.build_complete',
  'media.uploaded', 'form.submitted',
])

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

// RFC 1918 + loopback + link-local + cloud metadata blocked
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^metadata\.google\.internal$/i,
  /^169\.254\.169\.254$/,
]

// ─── SSRF Protection ───

/** Validate webhook URL is safe — block internal networks and cloud metadata. */
export function isAllowedWebhookUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
    for (const pattern of BLOCKED_HOST_PATTERNS) {
      if (pattern.test(hostname)) return false
    }
    return true
  }
  catch {
    return false
  }
}

// ─── Signature ───

/** Generate HMAC-SHA256 signature for webhook payload. */
export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/** Verify HMAC-SHA256 signature using crypto.timingSafeEqual. */
export function verifySignature(payload: string, secret: string, signature: string): boolean {
  const expected = signPayload(payload, secret)
  if (expected.length !== signature.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
  }
  catch {
    return false
  }
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

  // Find matching active webhooks — scoped by workspace + project
  const { data: webhooks } = await admin
    .from('webhooks')
    .select('id, url, events, secret, active')
    .eq('workspace_id', workspaceId)
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

  for (const webhook of matchingWebhooks as WebhookRow[]) {
    // SSRF check at delivery time (DNS can change)
    if (!isAllowedWebhookUrl(webhook.url)) continue

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
        // Fire-and-forget: attempt initial delivery
        attemptDelivery(admin, webhook, payload, delivery.id, 0).catch(() => {})
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
 * Attempt delivery and update record. retryCount drives backoff.
 * Called by both initial emission and retry processor.
 */
async function attemptDelivery(
  admin: ReturnType<typeof useSupabaseAdmin>,
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
      if (responseBody && responseBody.length > 1000) {
        responseBody = responseBody.substring(0, 1000)
      }
    }
    catch { /* ignore */ }

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

/**
 * Process pending webhook retries.
 * Called periodically (e.g. every 60s via server plugin setInterval).
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
    const retryCount = delivery.retry_count ?? 0
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

    if (!webhook || !isAllowedWebhookUrl(webhook.url)) {
      await admin.from('webhook_deliveries').update({ status: 'failed' }).eq('id', delivery.id)
      processed++
      continue
    }

    await attemptDelivery(
      admin,
      webhook as WebhookRow,
      delivery.payload as WebhookPayload,
      delivery.id,
      retryCount,
    )
    processed++
  }

  return processed
}
