// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  // Copied byte for byte from the starter (see tests/fixtures/starter/README.md): reformatting it would hide drift.
  { ignores: ['tests/fixtures/starter/**'] },
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
