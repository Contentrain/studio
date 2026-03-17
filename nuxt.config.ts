import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', '@nuxt/image'],

  devtools: { enabled: true },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    supabase: {
      url: '',
      serviceRoleKey: '',
    },
    public: {
      siteUrl: 'http://localhost:3000',
      supabase: {
        url: '',
        anonKey: '',
      },
    },
  },

  alias: {
    '#contentrain': resolve(__dirname, '.contentrain/client/index.mjs'),
  },
  compatibilityDate: '2025-07-15',
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      include: ['@supabase/supabase-js'],
    },
  },

  eslint: {
    config: {
      stylistic: true,
    },
  },
})
