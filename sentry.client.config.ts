// Client-side Sentry initialisation (browser SPA — ssr is disabled).
// Loaded by the @sentry/nuxt module. Config is read from
// runtimeConfig.public.sentry so it stays env-driven per deployment.
//
// NOTE: keep Sentry confined to this framework-level entry. Application code
// (components, composables, pages, server routes) must NOT import @sentry/*
// directly — error capture is wired automatically by the module.
import * as Sentry from '@sentry/nuxt'
import { useRuntimeConfig } from '#imports'

const sentry = useRuntimeConfig().public.sentry

// No DSN → Sentry stays a no-op. This is the Community/self-host default, so a
// self-hoster never ships telemetry to an external Sentry they don't control.
if (sentry?.dsn) {
  Sentry.init({
    dsn: sentry.dsn,
    environment: sentry.environment || undefined,
    release: sentry.release || undefined,
    // Performance tracing sample. Unhandled errors are always captured at 100%
    // regardless of this rate.
    tracesSampleRate: Number(sentry.tracesSampleRate ?? 0.1),
    // Never attach PII (user email/IP, request bodies) — this is an
    // authenticated content surface. Opt in explicitly if ever needed.
    sendDefaultPii: false,
  })
}
