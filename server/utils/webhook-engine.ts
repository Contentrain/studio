/**
 * Webhook outbound engine — event emission + async delivery.
 *
 * Security: HMAC-SHA256 signature, SSRF protection, timing-safe verify.
 * Retry: exponential backoff — 1m, 5m, 30m, 2h, 12h (max 5 retries).
 *
 * Plan: Business+ (api.webhooks_outbound feature flag)
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { emitEnterpriseWebhookEvent, processEnterpriseWebhookRetries } from './enterprise'

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
  await emitEnterpriseWebhookEvent(projectId, workspaceId, event, data)
}

/**
 * Process pending webhook retries.
 * Called periodically (e.g. every 60s via server plugin setInterval).
 */
export async function processWebhookRetries(): Promise<number> {
  return processEnterpriseWebhookRetries()
}
