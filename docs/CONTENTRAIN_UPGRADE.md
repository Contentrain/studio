# Upgrading the Contentrain ecosystem packages

Studio depends on three packages published from `Contentrain/ai`:

| Package | Used for |
|---|---|
| `@contentrain/mcp` | Content engine — `core/ops` plan helpers, `core/validator`, `providers/github`, the loopback MCP Cloud server, tool annotations |
| `@contentrain/types` | Canonical contracts — `ModelDefinition`, `FieldDef`, `ContentrainConfig`, `PATH_PATTERNS`, `validateFieldValue`, path/serialisation helpers |
| `@contentrain/query` | Generated `#contentrain` client (dictionary/UI strings via `useContent().t()`) |

These are **not** ordinary dependencies. Treat every bump as a small migration.

## The one hard rule: bump all three together

`@contentrain/mcp` and `@contentrain/query` each pin an **exact** `@contentrain/types`
version. If Studio's own direct `@contentrain/types` pin drifts from theirs, pnpm
installs two copies and the shared types (`FieldDef`, `ModelDefinition`, …) silently
skew. Always move `mcp`, `types`, and `query` to their matching set in one PR. The
`contentrain` dependabot group (`.github/dependabot.yml`) already batches them into a
single PR for exactly this reason.

## Steps

1. **Read the changelogs first.** `gh api repos/Contentrain/ai/contents/packages/{mcp,types,sdk/js}/CHANGELOG.md -H "Accept: application/vnd.github.raw"`. Note any `BREAKING CHANGE`.
2. **Bump the trio** in `package.json` to the matching set, then `pnpm install`.
3. **Regenerate the client:** `pnpm exec contentrain-query generate` (writes the gitignored `.contentrain/client/`; CI regenerates it every build via the same bin).
4. **Adapt call sites.** Studio calls MCP's low-level `plan*` helpers directly (bypassing the tool handlers), so behaviour changes in `core/ops`/`core/validator`/`core/model-manager` land in Studio without a version bump doing it for you. Grep the import surface: `grep -rn "@contentrain/mcp" server`.
5. **Gate:** `pnpm typecheck && pnpm lint && pnpm test`.
6. **Verify the write path on staging — mocked git tests hide MCP write-path changes.** Do a real save / status-change / delete on the live project, including a **non-i18n model at a non-default locale** (the case a wrong meta path silently corrupts). Confirm meta lands where the readers look and the entry survives a CDN build.
7. **Scan the live content** before and after: run `contentrain_validate` on the project. New semantic rules (e.g. `slug`, `date`, `percent` in `@contentrain/types@0.9.0`) can turn previously-clean content into blocking errors.

## Landmines seen so far

- **Path helpers.** Studio delegates content/meta path assembly to MCP's
  `contentFilePath`/`documentFilePath`/`metaFilePath` (`server/utils/content-paths.ts`)
  precisely so it can't drift. Keep it that way — do not re-inline path logic.
- **`plan*` helpers don't validate.** Field/model constraint enforcement lives in the
  tool handlers and in `@contentrain/types.validateFieldValue`. Studio's native write
  path gets stricter content validation only through its own `validateContent` call
  (`server/utils/content-validation.ts`), and its native model validation is Studio's
  own (`server/utils/schema-validation.ts`) — MCP's `validateModelDefinition` is not
  imported.
- **Client generator bin.** The correct generator is `contentrain-query` (from
  `@contentrain/query`). There is no `contentrain` bin in `node_modules/.bin`; do not
  reintroduce `npx contentrain generate`.
- **Upstream gaps go to `Contentrain/ai`.** If a bump needs something MCP doesn't
  expose (e.g. `contentDirPath` is not exported from `core/ops`), file/patch it upstream
  rather than re-implementing it in Studio.
