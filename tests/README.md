# Test Structure

- `tests/unit`
  - Pure Node/domain tests for server utilities and business logic.
- `tests/integration`
  - HTTP-level route tests with real request/response, cookies, middleware, and provider-boundary mocks.
- `tests/nuxt`
  - Nuxt runtime tests for composables and components using `@nuxt/test-utils` and Vue Test Utils.
- `tests/rls`
  - Local Supabase/Postgres contract tests for row-level security and ownership boundaries.
- `tests/e2e`
  - App-level smoke tests using `@nuxt/test-utils/e2e`.
- `tests/contract`
  - Postgres `DatabaseProvider` contract tests against a throwaway `postgres:16` (`vitest.contract.config.ts`).
- `tests/wp-runtime`
  - Isolated HTTP + PostgreSQL acceptance, e.g. comment submit → approval → public read (`vitest.wp-runtime.config.ts`).
- `tests/fixtures`
  - Shared fixtures used by the suites.
- `tests/setup`
  - Shared Vitest setup files for each test project.
- `tests/helpers`
  - Shared HTTP and cookie helpers for route integration tests.

Scripts:
- `pnpm test`
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:nuxt`
- `pnpm test:rls`
- `pnpm test:e2e`
- `pnpm test:contract`
- `pnpm test:runtime`
- `pnpm test:coverage`
- `pnpm test:ci`
