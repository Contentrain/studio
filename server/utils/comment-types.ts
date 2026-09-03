/**
 * Model-level comments configuration — stored on the model definition under
 * `comments`, next to `form`. Git holds the *configuration* (what a model
 * allows); the Studio DB holds the comments themselves.
 */

export interface CommentsConfig {
  enabled: boolean
  /** New comments start `pending` (true) or `approved` (false; needs `comments.auto_approve`). */
  requireApproval: boolean
  /** Reply nesting cap for NEW public submissions (0 = flat). Import never clamps. */
  maxDepth: number
  /** Commenters must supply an email (never shown publicly). */
  requireEmail: boolean
  honeypot: boolean
  captcha: 'turnstile' | null
  /** Public submissions per IP per minute per entry. */
  rateLimitPerIp: number
  /** Body length cap for public submissions. */
  maxBodyLength: number
}

export const COMMENTS_CONFIG_DEFAULTS: CommentsConfig = {
  enabled: false,
  requireApproval: true,
  maxDepth: 4,
  requireEmail: true,
  honeypot: true,
  captcha: null,
  rateLimitPerIp: 5,
  maxBodyLength: 5000,
}

/** Hard ceilings a model config cannot exceed, whatever the author typed. */
export const COMMENTS_CONFIG_LIMITS = {
  maxDepth: 10,
  rateLimitPerIp: 60,
  maxBodyLength: 20000,
} as const

/** Read the `comments` block off a model definition (loosely typed from brain cache). */
export function getCommentsConfig(model: unknown): CommentsConfig | undefined {
  const raw = (model as { comments?: Partial<CommentsConfig> } | null | undefined)?.comments
  if (!raw || typeof raw !== 'object') return undefined
  return normalizeCommentsConfig(raw)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/** Fill defaults + clamp — every reader sees one shape regardless of what was saved. */
export function normalizeCommentsConfig(raw: Partial<CommentsConfig>): CommentsConfig {
  return {
    enabled: raw.enabled === true,
    requireApproval: raw.requireApproval !== false,
    maxDepth: clampInt(raw.maxDepth, COMMENTS_CONFIG_DEFAULTS.maxDepth, 0, COMMENTS_CONFIG_LIMITS.maxDepth),
    requireEmail: raw.requireEmail !== false,
    honeypot: raw.honeypot !== false,
    captcha: raw.captcha === 'turnstile' ? 'turnstile' : null,
    rateLimitPerIp: clampInt(raw.rateLimitPerIp, COMMENTS_CONFIG_DEFAULTS.rateLimitPerIp, 1, COMMENTS_CONFIG_LIMITS.rateLimitPerIp),
    maxBodyLength: clampInt(raw.maxBodyLength, COMMENTS_CONFIG_DEFAULTS.maxBodyLength, 100, COMMENTS_CONFIG_LIMITS.maxBodyLength),
  }
}

/** How many models in a brain cache have comments enabled (plan-limit input). */
export function countCommentEnabledModels(models: Map<string, unknown>): number {
  let count = 0
  for (const model of models.values()) {
    if (getCommentsConfig(model)?.enabled) count++
  }
  return count
}

/** Only entry-bearing models can carry a thread. */
export function modelSupportsComments(model: unknown): boolean {
  const kind = model as { kind?: string, type?: string } | null | undefined
  const k = kind?.kind ?? kind?.type
  return k === 'collection' || k === 'document'
}
