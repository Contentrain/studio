// Server-side (Nitro) Sentry initialisation. Loaded by the @sentry/nuxt module
// and injected at the top of the server entry (autoInjectServerSentry:
// 'top-level-import'), so it runs before Nuxt's runtime context exists — read
// configuration from process.env rather than useRuntimeConfig().
//
// ssr is disabled, so this instruments the Nitro API routes, server plugins and
// cron jobs (webhooks, usage drain, trial reminders, branch cleanup, etc.).
import * as Sentry from '@sentry/nuxt'

// Nuxt maps NUXT_PUBLIC_SENTRY_* env vars onto runtimeConfig, but those are read
// straight from the environment here since runtimeConfig isn't ready yet.
const dsn = process.env.NUXT_PUBLIC_SENTRY_DSN

// No DSN → Sentry stays a no-op (Community/self-host default).
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NUXT_PUBLIC_SENTRY_ENVIRONMENT || undefined,
    release: process.env.NUXT_PUBLIC_SENTRY_RELEASE || undefined,
    tracesSampleRate: Number(process.env.NUXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Never attach PII (request bodies, headers, user identifiers).
    sendDefaultPii: false,
  })
}
