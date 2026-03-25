# Test Structure

- `tests/unit`
  - Pure Node/domain tests for server utilities and business logic.
- `tests/nuxt`
  - Nuxt runtime tests for composables and components using `@nuxt/test-utils` and Vue Test Utils.
- `tests/e2e`
  - App-level smoke tests using `@nuxt/test-utils/e2e`.
- `tests/setup`
  - Shared Vitest setup files for each test project.

Scripts:
- `pnpm test`
- `pnpm test:unit`
- `pnpm test:nuxt`
- `pnpm test:e2e`
- `pnpm test:coverage`
- `pnpm test:ci`
