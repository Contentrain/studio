# WordPress migration acceptance — 2026-09-09

Status: **not end-to-end accepted**. This is a cross-repository contract probe,
not a browser journey or a fidelity measurement. The opt-in test deliberately
fails the lossless-import gate; do not lower that gate to make the run green.

## Evidence

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

The importer currently assigns a parent only when parent and child share a
model (`packages/wp-import/src/contentrain.ts`). Cross-type links increment
`dropped_relations`. Do not call these 52 lost articles. Decide whether plugin
configuration types are intentionally excluded with an explicit report, or
preserve their cross-model relationships. ACF handling needs its own regression
fixture either way.

## Required next gates

1. Resolve plugin configuration and cross-type parent semantics in AI importer.
2. Use the actual extraction/pipeline ProjectIR and generated handoff, build the
   Astro project, and verify content routes in a browser.
3. Bind emitted runtime components to Studio: existing emitter components are
   placeholders that state a live provider is required. Prove comment reading,
   writing/moderation and form submission/approval on the generated site.
4. Transfer media to a test storage provider; verify byte integrity and that
   generated pages no longer depend on the old WP URLs.
5. Schedule a real entry and verify it is hidden before, visible after the
   deadline, with failed delivery/retry and public-cache behavior covered.

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
