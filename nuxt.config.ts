import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', '@nuxt/image'],

  devtools: { enabled: true },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    sessionSecret: '', // NUXT_SESSION_SECRET — min 32 chars, AES-256 cookie encryption
    github: {
      appId: '',
      clientId: '',
      clientSecret: '',
      privateKey: '', // base64 encoded .pem
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
