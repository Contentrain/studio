# Contributing to Contentrain Studio

Thanks for your interest in contributing to Contentrain Studio.

Please read these documents before opening a pull request:

- [README](README.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

Security vulnerabilities must be reported privately to [security@contentrain.io](mailto:security@contentrain.io), not through public issues.

## What We Accept

Community contributions are welcome for the AGPL core of the product, including:

- Bug fixes
- Tests
- Documentation
- Developer tooling improvements
- Accessibility and UX improvements
- Performance, correctness, and maintainability improvements

The proprietary `ee/` directory is not open for general community contribution unless maintainers explicitly coordinate that work with you.

## Developer Certificate of Origin

Contentrain Studio uses the DCO, not a CLA.

By contributing, you certify that you have the right to submit the work under the project license terms. Sign off each commit with:

```bash
git commit -s
```

This appends a `Signed-off-by:` line to your commit message.

## Development Setup

### Requirements

- Node.js 22+
- pnpm 10+
- Supabase CLI
- Git
- A working `.env` file based on `.env.example`

### Local Setup

```bash
git clone https://github.com/Contentrain/studio.git
cd studio
pnpm install
cp .env.example .env
pnpm db:start
pnpm db:migrate
npx contentrain generate
pnpm dev
```

Useful commands:

```bash
pnpm lint
pnpm lint:fix
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:nuxt
pnpm test:rls
pnpm test:e2e
pnpm test:ci
pnpm build
```

## Architecture Rules

The most important project rules are architectural, not stylistic.

### Provider Pattern

Contentrain Studio is deployment-agnostic and self-hosted-first. External services are accessed only through provider interfaces in `server/providers/`.

Do not:

- Import `@supabase/supabase-js` outside provider implementations
- Use provider-specific auto-injected composables in routes, pages, or components
- Leak vendor details into application logic
- Hardcode plan logic when `hasFeature()` exists

Application code should depend on provider interfaces and factories in `server/utils/providers.ts`.

### UI and Design Rules

- Use the Studio semantic color system, not raw Tailwind color families
- Follow the atomic component structure: atoms, molecules, organisms
- Keep app layouts inside `app/layouts/`
- Use `NuxtImg` for images
- Preserve accessibility rules for button types, focus visibility, and ARIA usage

### No Hardcoded Strings

User-facing UI text belongs in the Contentrain dictionary and should be accessed through the generated `@contentrain/query` client.

If you add new UI text:

1. Add the string to the relevant dictionary model
2. Regenerate the client
3. Use the generated lookup instead of hardcoding text

### `ee/` Boundary

Contentrain Studio follows an open-core model:

- Core: AGPL
- `ee/`: proprietary

Do not copy enterprise-only behavior into core or make core depend on `ee/` implementation details. Graceful degradation should keep core functional without enterprise code present.

## Style and Commits

- Conventional Commits are enforced
- Husky and lint-staged run on commits
- ESLint is the formatter/linter of record
- This repository does not use Prettier

Keep changes focused. Avoid mixing refactors, docs, and feature work in a single PR unless they are inseparable.

## Testing Expectations

Choose the smallest relevant set, but cover behavioral changes with real tests whenever possible.

- `test:unit`: pure logic and route handler tests
- `test:integration`: route integration and server wiring
- `test:nuxt`: composables and Nuxt runtime behavior
- `test:rls`: Row-Level Security behavior
- `test:e2e`: browser and user-flow regressions

Before opening a PR, run:

```bash
pnpm lint
pnpm typecheck
pnpm test:ci
```

Also run `pnpm test:rls` and `pnpm test:e2e` when your change touches auth, permissions, delivery, forms, media, or end-user workflows.

## Pull Requests

When opening a PR:

- Link the relevant issue or discussion
- Explain the change and the user-facing impact
- Add or update tests for regressions
- Update documentation when behavior or contracts change
- Keep architectural boundaries intact

Large or risky changes should start as an issue or discussion before implementation.

## Reporting Bugs and Requesting Features

Use GitHub issue templates for:

- Reproducible bugs
- Concrete feature proposals

Use GitHub Discussions for questions, architecture discussion, and early idea validation.

## Need Help?

- Technical/product questions: [GitHub Discussions](https://github.com/Contentrain/studio/discussions)
- Security reports: [security@contentrain.io](mailto:security@contentrain.io)
