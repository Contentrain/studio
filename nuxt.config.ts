import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', '@nuxt/image', ...(isTestEnv ? [] : ['nuxt-mcp-dev'])],
  ssr: false,
  devtools: { enabled: true },
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
      r2Bucket: 'contentrain-cdn', // NUXT_CDN_R2_BUCKET
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
    },
    deploymentProfile: '', // NUXT_DEPLOYMENT_PROFILE — 'managed' | 'dedicated' | 'on-premise' | 'community' (unset = auto-detect)
    emailSenderAddress: '', // NUXT_EMAIL_SENDER_ADDRESS
    emailSenderName: '', // NUXT_EMAIL_SENDER_NAME
  },

  alias: {
    '#contentrain': resolve(__dirname, '.contentrain/client/index.mjs'),
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
})
