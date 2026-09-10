# WordPress migration acceptance — 2026-09-10

Status: local code and contract checks pass; complete hosted release acceptance
remains open. Customer pilots are not a prelaunch prerequisite.

## Current implementation and evidence

- Published baseline: importer 0.4.0 and emitter 0.9.1; Migrate's inspected lock
  still selected 0.3.0 / 0.9.0 on September 10. Intake and portable runtime clients
  are implemented; the older placeholder and “not consumed” descriptions below
  are historical, not current blockers.
- This correction adds deterministic form approval identities, an approved-entry
  guard, retryable validation/merge failures, and disabled moderation buttons
  while the request is pending. Existing duplicated entries are not auto-deleted.
- AI corrections cover multilingual identity collisions, parameterless content
  routes, asset typechecking, and opt-in public build publication windows.
- Local test evidence: Studio unit/integration/Nuxt suites and production build;
  PostgreSQL contract suite; generated Astro static-route build; HTTP → PostgreSQL
  comments acceptance with model/entry/locale isolation and private-field checks.
  Git config, licensing and rate limits are explicit seams in the HTTP/DB test.
- Internal staging records separately establish comment import/submit/moderation,
  form submit/approval and media delivery. These hosted journeys were not rerun
  as part of the local correction and do not establish mobile or complete media acceptance.

## Repeating HTTP/database acceptance

`CONTRACT_PG_URL=<disposable PostgreSQL URL> pnpm test:runtime` runs the persisted
comments journey. It runs in the Postgres CI job after provider contract tests.
It deliberately uses provider-level moderation; it is not an authenticated UI test.

## Historical published-package probe (September 9)

The initial probe used wp-import 0.2.1, emitter-astro 0.7.0 and types 1.10.0.
Parent-relation fixes subsequently preserved all 71 exported fixture parent links,
removed the dangling skipped wp_navigation address, and reduced dropped relations
to zero. Historical baseline failures below remain as evidence of that correction.

## Original baseline evidence (before the fix)

The local WordPress fixture WXR was read by the real `wp-import` build. Studio
used an isolated PostgreSQL 16 database with migrations 000–025 applied.
Git file reads were an in-memory adapter; no GitHub repository was created.

| Check | Observed result | Boundary |
| --- | --- | --- |
| Content mapping | 130 source records, 130 entry addresses | Not 130 verified public pages; plugin configuration records are included |
| Lossless relations | **FAIL: 52 dropped relations** | All 52 match cross-type parent links in this fixture; examples include `acf-field` → `acf-field-group` |
| Handoff intake | Passed | Production intake utility, synthetic handoff using real comment export |
| Comments | 15 inserted; repeat import skipped all 15; no reported unmapped/orphan records | Real database, not generated-site UI |
| Form approval | Passed | Synthetic submission using database provider; no browser submission or agent approval tested |
| Schedule acknowledgement | Passed | Database claim/settle; does not prove timed public visibility or deploy delivery |
| Astro emission | 8 files, including index route | Minimal synthetic ProjectIR, not the source site's full layout or a built preview |
| Media | 7 source files fetched successfully from local WP, 11,482 bytes total (separate read-only probe) | CDN transfer, storage persistence and rewritten URLs untested |

The baseline importer assigned a parent only when parent and child shared a
model (`packages/wp-import/src/contentrain.ts`). Cross-type links increment
`dropped_relations`. These were not 52 lost articles. The follow-up preserves
cross-model relationships and adds ACF parent regression coverage; it does not
claim to reimplement ACF behavior in the destination runtime.

## Remaining deployment gates

- Adopt the corrected published packages in Migrate and regenerate entry maps,
  comment exports and static pages together. Source-checkout tests do not prove npm adoption.
- Repeat mobile generated-site journeys against the deployed Studio version.
- Verify complete media coverage, source-to-output provenance and zero unexpected
  old-origin references. A transformed WebP is not byte-identical to the source:
  check dimensions/decodability and visual equivalence; use source/output hashes
  to identify each side of the transformation. Explain every untransferred URL.
- Exercise scheduled rebuild/deploy, retries, public-cache visibility and rollback
  on a generated project. Unit boundaries and DB leases do not prove hosted delivery.
- Complete Migrate route/editability/family gates and blind acceptance separately.

## Reproduction

Run from a Studio checkout with installed dependencies. Supply absolute paths
to the actual WXR and built importer/emitter entry points. Use only a disposable
database: the contract setup applies migrations and creates/deletes test rows.

```sh
WP_ACCEPTANCE_WXR=/absolute/path/export.xml \
WP_ACCEPTANCE_IMPORTER=/absolute/path/wp-import/dist/index.mjs \
WP_ACCEPTANCE_EMITTER=/absolute/path/emitter-astro/dist/index.mjs \
CONTRACT_PG_URL=postgres://postgres:postgres@127.0.0.1:54339/postgres \
pnpm exec vitest run --config vitest.contract.config.ts \
  tests/contract/wp-migration-acceptance.contract.test.ts
```

Without all three WP acceptance variables, the test is skipped, not passed.
The fixture and sibling repositories are intentionally not CI prerequisites.
No production database, live deployment, hosted media or external customer data
was changed by this acceptance run.
