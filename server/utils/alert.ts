/**
 * Data-loss risk alerting.
 *
 * Several destructive paths (the CDN build's stale-object sweep, the per-project
 * R2 teardown on account/workspace/project deletion) historically swallowed
 * their errors as "non-fatal" — so a partial or total mass deletion surfaced
 * only when someone noticed missing assets. This routes those failures to the
 * server log (always) and Sentry (when configured) so they page us instead of a
 * customer.
 *
 * Contract: pass ONLY ids, counts and operation names — never user content — so
 * this stays compatible with Sentry's `sendDefaultPii: false`.
 */

export interface DataLossContext {
  /** Stable operation id, e.g. 'cdn-build.cleanup', 'project-delete.r2'. */
  op: string
  projectId?: string
  workspaceId?: string
  /** Anything else that helps triage — counts, flags. NEVER user content. */
  [key: string]: unknown
}

/**
 * Report that a data-destructive operation failed or behaved anomalously.
 * Never throws and never blocks — safe to call from inside an already-failing
 * `catch`.
 */
export function reportDataLossRisk(error: unknown, context: DataLossContext): void {
  const { op, ...extra } = context
  const message = error instanceof Error ? error.message : String(error)

  // Always-on signal: visible in server logs even without Sentry (self-host).
  // eslint-disable-next-line no-console
  console.error(`[data-loss-risk] ${op}: ${message}`, extra)

  // Best-effort escalation to Sentry. Dynamic import keeps @sentry/nuxt out of
  // this module's static graph (so unit tests importing callers don't eagerly
  // load the SDK), and fire-and-forget means alerting never blocks or throws
  // inside an already-failing destructive path.
  void import('@sentry/nuxt')
    .then((Sentry) => {
      Sentry.captureException(error instanceof Error ? error : new Error(message), {
        level: 'error',
        tags: { data_loss_risk: 'true', op },
        extra,
      })
    })
    .catch(() => { /* Sentry unavailable — the console.error above is the fallback */ })
}

export interface BillingRiskContext {
  /** Stable operation id, e.g. 'usage-settle.agent_tokens_v3'. */
  op: string
  workspaceId?: string
  /** Anything else that helps triage — counts, flags. NEVER user content. */
  [key: string]: unknown
}

/**
 * Report that a usage-metering write failed or behaved anomalously (e.g.
 * the turn-end credit-settle RPC). These calls are intentionally
 * best-effort — a metering hiccup must never break the user's turn — but
 * "best-effort" previously meant "silent": the settle RPC could fail on
 * every single call (missing function after an incomplete migration,
 * wrong param shape) and nothing would ever surface it, leaving the
 * credit ledger permanently under-counting usage with no signal. Same
 * shape as `reportDataLossRisk` — log always, escalate to Sentry
 * best-effort — for the same reason: self-hosters without Sentry still
 * get the log line, and nothing here can throw back into the caller.
 */
export function reportBillingRisk(error: unknown, context: BillingRiskContext): void {
  const { op, ...extra } = context
  const message = error instanceof Error ? error.message : String(error)

  // eslint-disable-next-line no-console
  console.error(`[billing-risk] ${op}: ${message}`, extra)

  void import('@sentry/nuxt')
    .then((Sentry) => {
      Sentry.captureException(error instanceof Error ? error : new Error(message), {
        level: 'error',
        tags: { billing_risk: 'true', op },
        extra,
      })
    })
    .catch(() => { /* Sentry unavailable — the console.error above is the fallback */ })
}

export interface AgentToolErrorContext {
  /** Tool name as sent to the model, e.g. 'save_content', 'delete_content'. */
  tool: string
  projectId: string
  workspaceId: string
  modelId?: string
  /** `Error.constructor.name` for a thrown error, or a fixed label for a `{ error }` tool result. */
  errorClass: string
}

/**
 * Report that an agent tool call returned or threw an error.
 *
 * Tool errors were previously returned to the model as data only — never
 * reported anywhere — so the most user-visible failures (delete_content,
 * save_content) were invisible to monitoring. Unlike `reportDataLossRisk` /
 * `reportBillingRisk`, the error message itself is NOT sent to Sentry: tool
 * errors run through content-validation paths that can echo a field value
 * the editor typed, so only ids, the tool name and the error class travel
 * — the full message stays in the server log only.
 */
export function reportAgentToolError(message: string, context: AgentToolErrorContext): void {
  const { tool, errorClass, modelId, projectId, workspaceId } = context

  // eslint-disable-next-line no-console
  console.error(`[agent-tool-error] ${tool}: ${message}`, { projectId, workspaceId, modelId, errorClass })

  void import('@sentry/nuxt')
    .then((Sentry) => {
      Sentry.captureMessage(`agent tool error: ${tool}`, {
        level: 'warning',
        tags: { agent_tool_error: 'true', tool, error_class: errorClass },
        extra: { projectId, workspaceId, modelId },
      })
    })
    .catch(() => { /* Sentry unavailable — the console.error above is the fallback */ })
}
