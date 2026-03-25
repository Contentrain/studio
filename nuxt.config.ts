import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', '@nuxt/image', 'nuxt-mcp-dev'],
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
    public: {
      siteUrl: 'http://localhost:3000',
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
  },

  eslint: {
    config: {
      stylistic: true,
    },
  },
})
