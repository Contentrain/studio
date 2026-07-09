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
