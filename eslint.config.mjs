// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    rules: {
      'no-console': 'warn',
    },
  },
)
  .override('nuxt/vue/rules', {
    rules: {
      'vue/max-attributes-per-line': 'off',
    },
  })
