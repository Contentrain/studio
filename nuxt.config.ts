import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint'],

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
    '#contentrain': './.contentrain/client/index.mjs',
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
