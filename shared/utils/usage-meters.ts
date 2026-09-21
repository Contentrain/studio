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
  /**
   * How the provider must aggregate the ingested events.
   *
   * `count` bills one per event and is only correct when every event
   * carries a value of 1. `sum` adds up `metadata.value`, which is what a
   * meter whose events carry a quantity — credits, bytes — needs.
   */
  readonly aggregation: 'count' | 'sum'
  /**
   * Meter units in one unit of `limitKey`.
   *
   * Usually 1: a credit is a credit, a submission is a submission. Not for
   * the two byte meters, where the plan limit is in gigabytes and the
   * meter sums raw bytes. Getting this wrong in either direction is
   * expensive — it sets both the included allowance and the unit price.
   */
  readonly unitsPerLimitUnit: number
  /**
   * Whether usage past the plan limit may be sold.
   *
   * False means the limit is hard: no metered price, no included
   * allowance, and the app refuses to raise the cap even if the workspace
   * has the overage toggle on. The two byte meters are false because they
   * cannot carry an allowance — Polar caps a meter credit at int32 and a
   * gigabyte in bytes exceeds it — and billing overage against an
   * allowance that cannot be expressed would charge from the first byte.
   * Events still flow, so the usage is measured and shown; it just is not
   * sold until the meter counts the unit the plan sells.
   */
  readonly overageBillable: boolean
}

export const USAGE_METERS = {
  // `ai_credits` / `api_credits`, not the older `ai_messages` /
  // `api_messages`: those were created counting events, which was right
  // while a turn was worth exactly one message. Credit weighting made a
  // turn emit a base event plus a top-up event carrying N extra credits,
  // so counting bills 2 where the ledger says N+1. A meter's aggregation
  // cannot be changed once it holds events without restating history, so
  // the corrected meters are new ones.
  AI_MESSAGES: {
    name: 'ai_credits',
    limitKey: 'ai.messages_per_month',
    settingsKey: 'ai_messages',
    unitLabel: 'credit',
    aggregation: 'sum',
    unitsPerLimitUnit: 1,
    overageBillable: true,
  },
  API_MESSAGES: {
    name: 'api_credits',
    limitKey: 'api.messages_per_month',
    settingsKey: 'api_messages',
    unitLabel: 'credit',
    aggregation: 'sum',
    unitsPerLimitUnit: 1,
    overageBillable: true,
  },
  MCP_CALLS: {
    name: 'mcp_calls',
    limitKey: 'api.mcp_calls_per_month',
    settingsKey: 'mcp_calls',
    unitLabel: 'call',
    // Every MCP event carries value 1, so counting and summing agree.
    aggregation: 'count',
    unitsPerLimitUnit: 1,
    overageBillable: true,
  },
  CDN_BANDWIDTH_BYTES: {
    name: 'cdn_bandwidth_bytes',
    limitKey: 'cdn.bandwidth_gb',
    settingsKey: 'cdn_bandwidth',
    unitLabel: 'byte',
    aggregation: 'sum',
    unitsPerLimitUnit: 1024 ** 3,
    overageBillable: false,
  },
  FORM_SUBMISSIONS: {
    name: 'form_submissions',
    limitKey: 'forms.submissions_per_month',
    settingsKey: 'form_submissions',
    unitLabel: 'submission',
    aggregation: 'count',
    unitsPerLimitUnit: 1,
    overageBillable: true,
  },
  MEDIA_STORAGE_BYTE_HOURS: {
    name: 'media_storage_byte_hours',
    limitKey: 'media.storage_gb',
    settingsKey: 'media_storage',
    unitLabel: 'byte·hour',
    aggregation: 'sum',
    unitsPerLimitUnit: 1024 ** 3,
    overageBillable: false,
  },
} as const satisfies Record<string, UsageMeterDefinition>

export type UsageMeterKey = keyof typeof USAGE_METERS
export type UsageMeterName = (typeof USAGE_METERS)[UsageMeterKey]['name']

export const USAGE_METER_LIST: readonly UsageMeterDefinition[] = Object.values(USAGE_METERS)
