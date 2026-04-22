/**
 * Usage meter definitions.
 *
 * Each meter maps to:
 *   - a plan limit key in `PLAN_LIMITS` (`shared/utils/license.ts`)
 *   - an `OVERAGE_PRICING` entry (settingsKey) for overage pricing
 *   - a Polar meter slug used by the plugin when ingesting events
 *
 * Keeping a single manifest avoids drift between the overage-settings UI,
 * the outbox writer, and the Polar meter setup script.
 */

export interface UsageMeterDefinition {
  /** Stable short name — matches Polar meter slug. */
  readonly name: string
  /** Plan-limit key (`ai.messages_per_month`, `cdn.bandwidth_gb`, …). */
  readonly limitKey: string
  /** Settings key used inside `workspaces.overage_settings` JSONB. */
  readonly settingsKey: string
  /** Human-readable unit label (for logs / Polar display). */
  readonly unitLabel: string
}

export const USAGE_METERS = {
  AI_MESSAGES: {
    name: 'ai_messages',
    limitKey: 'ai.messages_per_month',
    settingsKey: 'ai_messages',
    unitLabel: 'message',
  },
  API_MESSAGES: {
    name: 'api_messages',
    limitKey: 'api.messages_per_month',
    settingsKey: 'api_messages',
    unitLabel: 'message',
  },
  MCP_CALLS: {
    name: 'mcp_calls',
    limitKey: 'api.mcp_calls_per_month',
    settingsKey: 'mcp_calls',
    unitLabel: 'call',
  },
  CDN_BANDWIDTH_BYTES: {
    name: 'cdn_bandwidth_bytes',
    limitKey: 'cdn.bandwidth_gb',
    settingsKey: 'cdn_bandwidth',
    unitLabel: 'byte',
  },
  FORM_SUBMISSIONS: {
    name: 'form_submissions',
    limitKey: 'forms.submissions_per_month',
    settingsKey: 'form_submissions',
    unitLabel: 'submission',
  },
  MEDIA_STORAGE_BYTE_HOURS: {
    name: 'media_storage_byte_hours',
    limitKey: 'media.storage_gb',
    settingsKey: 'media_storage',
    unitLabel: 'byte·hour',
  },
} as const satisfies Record<string, UsageMeterDefinition>

export type UsageMeterKey = keyof typeof USAGE_METERS
export type UsageMeterName = (typeof USAGE_METERS)[UsageMeterKey]['name']

export const USAGE_METER_LIST: readonly UsageMeterDefinition[] = Object.values(USAGE_METERS)
