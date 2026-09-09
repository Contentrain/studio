# WordPress runtime integration: session ownership

2026-09-09. Contract acceptance is not generated-site acceptance. Each session
uses its own branch/worktree; no production deployments or shared DB resets.

| Session | Owned scope | Required evidence |
| --- | --- | --- |
| Release / acceptance (current session) | Studio `tests/contract/wp-migration-acceptance.contract.test.ts`, `docs/WP_MIGRATION_ACCEPTANCE.md`, PR #248; AI release PR #159 | Published importer 0.2.1, merged Studio scheduling code, real fixture + disposable PostgreSQL contract run |
| AI SDK / portable runtime | `packages/sdk/js/src/cdn/forms-client.ts`, SDK tests; subsequently `packages/emitter-astro/src/` and related tests | Forms client matches Studio HTTP payloads; then generated Astro components actually mount and execute requests |
| Studio public API | `server/api/forms/v1/`, `server/api/comments/v1/`, public CORS and corresponding integration/contract tests | Stable request/response fixtures; validation, CAPTCHA, CORS, privacy, moderation and DB isolation tested |
| Migrate intake / orchestration | `packages/pipeline/`, `tools/migrate-site.mjs`, `tools/lib/handoff.mjs`, associated tests; own internal track | Published importer used by a real intake path; actual EntrySourceMap and comments export carried into handoff; runtime addresses bound to generated routes |

## Start in parallel, integrate in order

1. AI and Studio agree on existing HTTP examples before changing interfaces.
   Studio owns the server contract; AI consumes it. Shared types, if needed,
   are changed only by the AI session. Do not duplicate DTOs without tests.
2. Migrate can independently implement importer intake using the existing
   `RawIR`, `EntrySourceMap` and `CommentsExport` contracts. Do not copy Studio
   implementation code or create a second comment export format.
3. AI fixes the forms SDK first, then comments client / portable components.
   Component emission must include mount/import wiring, not only unused files.
4. Migrate consumes published versions and binds real model/entry/locale values.
5. Current acceptance session runs one generated-site browser journey only
   after these prerequisites land. Package tests alone cannot close that gate.

## Confirmed forms mismatch to address first

The inspected SDK sends flat form data and `cf-turnstile-response`. Studio
expects `{ data, captchaToken, _hp }`. SDK config assumes a fields array and
`captchaType`; Studio returns a fields map with `captcha`, `captchaSiteKey`
and `locale`. Public browser requests must not carry private credentials.
Do not relax server validation or CORS just to accommodate the old client.

## Boundaries and handoff receipt

- AI: MIT portable code/contracts; Studio: provider-backed runtime with existing
  core/EE boundaries; Migrate: private orchestration, no Studio source imports.
- Managing content remains conversation-first. No new admin editor is part of
  this work. Visitor-facing forms/comments are distinct from management UI.
- Each session reports commit/PR, affected files, request/response fixtures,
  tests actually run, package versions and remaining blockers.
- Do not edit another session's files, release manifests/lockfiles or PR #248.
  Coordinate shared-type and package updates with the release session.
- Final gate: generated Astro → submit → Studio DB → moderation → public GET;
  pending/private content must not appear publicly. Media and scheduled public
  visibility have separate acceptance gates and are not implied by this flow.
