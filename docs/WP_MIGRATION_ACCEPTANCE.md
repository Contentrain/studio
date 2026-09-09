# WordPress migration acceptance — 2026-09-09

Status: **contract probe passes with the local parent-relation fix; not
end-to-end accepted**. This is not a browser journey or a fidelity measurement.
The original lossless-import gate remains unchanged.

## Follow-up: parent-relation fix

The `codex/wp-parent-relations` AI branch ([PR #158](https://github.com/Contentrain/ai/pull/158), commit `2d43942`) preserves parent targets using the
existing single-target ID / multi-target `{ model, ref }` contract. The local
fixture rerun passed with zero dropped relations. All **71 exported parent
links** were checked against the original WP parent IDs, including the 52 ACF
field → field-group links and same-type nested links. Studio comments import,
idempotency, form approval and schedule acknowledgement continued to pass.

The source still has 130 records; the corrected source map has **129** addresses.
The old map included an address for skipped `wp_navigation` record 148 that had no emitted
content entry. The fix removes such dangling addresses instead of counting them
as migrated content. This does not make plugin configuration executable in Astro.

Importer verification: 36 test executions passed, package typecheck/build and
targeted lint passed. Four new regression cases cover mixed-target ACF parents,
single-target same/cross-model parents, and missing/excluded parents. The opt-in
Studio acceptance run used the freshly built importer in `ai-parent-relations`,
not the previously published package. Release/consumer adoption remains separate.

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

## Required next gates

1. Land/release the parent-relation fix and consume that version in Migrate.
   Plugin configuration remains archived data, not automatically recreated
   plugin behavior; route discovery must distinguish it from public pages.
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
