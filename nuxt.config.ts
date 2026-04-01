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
    stripe: {
      secretKey: '', // NUXT_STRIPE_SECRET_KEY
      webhookSecret: '', // NUXT_STRIPE_WEBHOOK_SECRET
      starterPriceId: '', // NUXT_STRIPE_STARTER_PRICE_ID
      proPriceId: '', // NUXT_STRIPE_PRO_PRICE_ID
    },
    public: {
      siteUrl: 'http://localhost:3000',
      githubAppSlug: 'contentrain-studio', // NUXT_PUBLIC_GITHUB_APP_SLUG
    },
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
