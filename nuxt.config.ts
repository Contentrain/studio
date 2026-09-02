import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * The commit this build was made from, stamped into `runtimeConfig.public.build`
 * so `/about` and `/api/health` can name the running build. Every builder calls
 * it something different: `SOURCE_COMMIT` is the explicit hand-off (the
 * Dockerfile build arg, set by the release workflow), the rest are what CI
 * and PaaS builders export on their own. A local build asks git. Empty when
 * nothing knows — the page then shows the version alone rather than a made-up
 * sha.
 */
function resolveBuildCommit(): string {
  for (const key of ['SOURCE_COMMIT', 'RAILWAY_GIT_COMMIT_SHA', 'GITHUB_SHA', 'CI_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA']) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  }
  catch {
    return ''
  }
}

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // nuxt-auth-utils supplies the OAuth provider handlers for the managed
  // auth pair (server utils only — its session/client composables are unused;
  // Studio keeps its own sealed-cookie session in server/utils/session.ts).
  modules: ['@nuxt/eslint', '@nuxt/image', 'nuxt-auth-utils', ...(isTestEnv ? [] : ['@sentry/nuxt/module', 'nuxt-mcp-dev'])],
  ssr: false,
  devtools: { enabled: true },

  // Static <head> baseline for the pre-hydration SPA shell. Brand-level,
  // dictionary-independent infrastructure only — the dynamic, translatable
  // title template + Open Graph / Twitter tags are applied in app.vue via
  // useHead/useSeoMeta (driven by the Contentrain dictionary). The product
  // surface is an authenticated app, so it is excluded from search indexing.
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Contentrain Studio',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#3b82f6' },
        { name: 'robots', content: 'noindex, nofollow' },
        { name: 'format-detection', content: 'telephone=no' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
      ],
    },
  },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    sessionSecret: '', // NUXT_SESSION_SECRET — min 32 chars, AES-256 cookie encryption
    sessionSecretPrevious: '', // NUXT_SESSION_SECRET_PREVIOUS — old secret for key rotation migration
    github: {
      appId: '',
      clientId: '',
      clientSecret: '',
      privateKey: '', // base64 encoded .pem
      webhookSecret: '', // NUXT_GITHUB_WEBHOOK_SECRET — HMAC-SHA256 verification
    },
    anthropic: {
      apiKey: '', // NUXT_ANTHROPIC_API_KEY — Studio-hosted agent key
    },
    cdn: {
      r2AccountId: '', // NUXT_CDN_R2_ACCOUNT_ID
      r2AccessKeyId: '', // NUXT_CDN_R2_ACCESS_KEY_ID
      r2SecretAccessKey: '', // NUXT_CDN_R2_SECRET_ACCESS_KEY
      r2Bucket: '', // NUXT_CDN_R2_BUCKET — required when R2 creds are set (no implicit default)
    },
    // Provider selection — pairs must match: supabase+supabase (default) or
    // managed+postgres. Enforced at boot by server/plugins/00.validate-config.ts.
    authProvider: 'supabase', // NUXT_AUTH_PROVIDER — 'supabase' | 'managed'
    databaseProvider: 'supabase', // NUXT_DATABASE_PROVIDER — 'supabase' | 'postgres'
    postgres: {
      url: '', // NUXT_POSTGRES_URL — required when databaseProvider=postgres
    },
    authJwtSecret: '', // NUXT_AUTH_JWT_SECRET — min 32 chars, managed-auth JWT signing
    // Directory-review support (managed pair only, both optional):
    openaiAppsChallenge: '', // NUXT_OPENAI_APPS_CHALLENGE — domain-verification token served at /.well-known/openai-apps-challenge
    reviewAccount: {
      email: '', // NUXT_REVIEW_ACCOUNT_EMAIL — the ONLY address the password login accepts
      password: '', // NUXT_REVIEW_ACCOUNT_PASSWORD — min 16 chars; unset = /auth/review-login does not exist
    },
    supabase: {
      url: '',
      serviceRoleKey: '',
      anonKey: '',
    },
    resend: {
      apiKey: '', // NUXT_RESEND_API_KEY
    },
    polar: {
      accessToken: '', // NUXT_POLAR_ACCESS_TOKEN
      webhookSecret: '', // NUXT_POLAR_WEBHOOK_SECRET
      starterProductId: '', // NUXT_POLAR_STARTER_PRODUCT_ID
      proProductId: '', // NUXT_POLAR_PRO_PRODUCT_ID
      server: 'production', // NUXT_POLAR_SERVER — 'sandbox' | 'production'
    },
    stripe: {
      secretKey: '', // NUXT_STRIPE_SECRET_KEY (optional — legacy Stripe plugin)
      webhookSecret: '', // NUXT_STRIPE_WEBHOOK_SECRET
      starterPriceId: '', // NUXT_STRIPE_STARTER_PRICE_ID
      proPriceId: '', // NUXT_STRIPE_PRO_PRICE_ID
    },
    public: {
      siteUrl: 'http://localhost:3000',
      githubAppSlug: 'contentrain-studio', // NUXT_PUBLIC_GITHUB_APP_SLUG
      billingEnabled: false, // NUXT_PUBLIC_BILLING_ENABLED — auto-derived on boot from configured payment plugins; set manually only to override
      templateOwner: 'Contentrain', // NUXT_PUBLIC_TEMPLATE_OWNER
      build: {
        // Stamped at build time; `/about` and `/api/health` read it. Overridable
        // per deployment via NUXT_PUBLIC_BUILD_VERSION / NUXT_PUBLIC_BUILD_COMMIT.
        version: pkg.version,
        commit: resolveBuildCommit(),
      },
      deployment: {
        // Client-visible deployment snapshot. In dev, `server/plugins/
        // 00.billing-flag.ts` mutates this at boot from the auto-detected
        // server-side `resolveDeployment()`. In production builds the
        // public runtime config may be frozen, so operators should set
        // the values explicitly via the corresponding env vars (Nuxt
        // automatically maps NUXT_PUBLIC_DEPLOYMENT_<KEY> to public.deployment.<key>).
        profile: '', // NUXT_PUBLIC_DEPLOYMENT_PROFILE — managed | dedicated | on-premise | community
        edition: '', // NUXT_PUBLIC_DEPLOYMENT_EDITION — ee | agpl
        billingMode: '', // NUXT_PUBLIC_DEPLOYMENT_BILLING_MODE — polar | stripe | flat | off
      },
      sentry: {
        // Client + server SDK config is driven entirely from here so Sentry
        // stays env-configurable per deployment. An empty DSN disables Sentry
        // completely (the SDK no-ops) — this is the Community/self-host default,
        // so a self-hoster's errors never leave their own infrastructure.
        dsn: '', // NUXT_PUBLIC_SENTRY_DSN
        environment: '', // NUXT_PUBLIC_SENTRY_ENVIRONMENT — development | staging | production
        release: '', // NUXT_PUBLIC_SENTRY_RELEASE — optional build/release identifier
        tracesSampleRate: 0.1, // NUXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE — perf-tracing sample (errors are always captured at 100%)
      },
    },
    emailSenderAddress: '', // NUXT_EMAIL_SENDER_ADDRESS
    emailSenderName: '', // NUXT_EMAIL_SENDER_NAME
  },

  alias: {
    '#contentrain': resolve(__dirname, '.contentrain/client/index.mjs'),
  },
  sourcemap: {
    // Emit client source maps for Sentry upload without referencing them from
    // the shipped bundle.
    client: 'hidden',
  },
  experimental: {
    viewTransition: true,
  },

  compatibilityDate: '2025-07-15',
  vite: {
    plugins: [tailwindcss()],
    worker: {
      format: 'es',
    },
  },

  eslint: {
    config: {
      stylistic: true,
    },
  },

  // Sentry build-time options (module). Runtime behaviour (DSN, environment,
  // sample rate) lives in runtimeConfig.public.sentry and is read by the
  // sentry.client.config.ts / sentry.server.config.ts entry files.
  sentry: {
    // Inject the server SDK at the top of the Nitro server entry so error +
    // performance instrumentation works with the plain
    // `node .output/server/index.mjs` start command (Railway) — no --import
    // flag or start-command change required.
    autoInjectServerSentry: 'top-level-import',
    // Source-map upload is build-time only and strictly opt-in: it runs solely
    // when SENTRY_AUTH_TOKEN (+ org/project) are present, so local builds and
    // forked CI (which never receive the secret) don't fail.
    sourceMapsUploadOptions: {
      enabled: Boolean(process.env.SENTRY_AUTH_TOKEN),
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    },
  },
})
