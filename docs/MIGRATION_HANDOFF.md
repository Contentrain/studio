# Migration Handoff

How a site migrated from WordPress by **Contentrain Migrate** arrives in Studio.
Migrate finishes every run by writing `contentrain-handoff.json` at the project
root of the generated repository. The file is the `MigrationHandoff` contract
from `@contentrain/types`: what the source site used, what happened to each
capability, which runtime offers are open, and, when the source had comments,
the `contentrain-comments@1` export (inline or by URL).

Migration completes without Studio; Studio is the upgrade for the capabilities
that need a live service (comments, forms, …). The handoff is how Studio knows
what to offer.

```
Migrate ──► GitHub repo (.contentrain/ + contentrain-handoff.json)
                 │
                 ▼  connect repository
Studio ── sync ─► projects.migration_handoff ──► overview card · agent context · one-click comments import
```

## What Studio does with it

- **On connect** (`POST /api/workspaces/{ws}/projects`): best-effort read of
  `contentrain-handoff.json` from the content branch, then the default branch
  (content root first, repository root second). A missing or malformed file
  never blocks the connect.
- **On demand**: `POST /api/workspaces/{ws}/projects/{p}/migration/sync`
  (owner/admin) re-reads and re-stores it; `422` for a document that fails the
  contract's shape. `GET …/migration` does the same once for an owner/admin
  when nothing is stored yet, or when the row predates the split below.
- **Enrichment**: `repository` is filled from the project (provider, owner,
  name, default branch) when Migrate could not know it.
- **Storage — manifest only**: `projects.migration_handoff` (+
  `migration_handoff_synced_at`, migration `021_migration_handoff.sql`) holds
  the manifest, never the comments export. `comments.export` is reduced to
  `{ format, url? }`, `comments.unresolved` to its first 100 rows, and Studio
  adds `studio_intake` (not part of the contract): the file's `path`/`ref`,
  file and manifest sizes, where the export is (`url` | `inline` | `none`)
  and the full unresolved count. The row is read on every project context, so
  a 3.5 MB inline export riding on it was paid for on every chat turn.
- **Size ceilings**: the file up to 100 MB (GitHub's blob limit), the stored
  manifest up to 1 MB, an inline or fetched export up to 50 MB. An oversized
  manifest is `413` naming the field (`manifest 2.0 MB > 1.0 MB; largest
  field: notes (2.0 MB)`). An oversized inline export does **not** fail the
  sync: the manifest is stored and the card/agent report
  `comments_export_too_large` with its size. The v2 cohort (24 real handoffs)
  stores 1.7–34 KB manifests; the largest file (3.5 MB) stores 3.6 KB.
- **Overview card** (`MigrationHandoffCard`): source site, generation date,
  content summary, capabilities grouped by disposition (`needs_runtime`,
  `migrated_static`, `external_adapter`, `kept_on_wordpress`, `archived`,
  `dropped`), open offers Studio can fulfil, notes, a "Needs attention" list
  (see *Issues*), and the comments state with a one-click import when the
  handoff carries an export.
- **Agent context**: a compact `## Migration (from WordPress)` block travels in
  the per-request context (never the cached system prompt) with a rule telling
  the agent which offers Studio can fulfil (comments, forms) and which it
  cannot yet (newsletter, e-commerce), so the first conversation on a migrated
  project starts from the manifest.

## Issues — what Studio cannot take over

`summary.issues` makes the gaps visible instead of accepting them silently:

| code | when |
|---|---|
| `offer_unsupported` | a `studio_managed` offer for a capability Studio has no runtime for (anything but `forms`, `comments` — e.g. `search`, `ecommerce`). The offer is also left out of *open offers*. |
| `runtime_unbound` | `forms`/`comments` still `needs_runtime` and the handoff has no `runtime` binding — the generated site is not pointed at this project yet. |
| `preview_url_missing` | no `preview_url`. |
| `comments_export_too_large` | the inline export is over 50 MB; publish it by URL. |

## Comments from the handoff

`POST /api/workspaces/{ws}/projects/{p}/migration/import-comments`
(owner/admin; plan features `comments.enabled` + `comments.import`) lands the
export through the same path as the manual upload (`docs/COMMENTS.md`). The
source comes from `studio_intake`: a URL is fetched server-side (SSRF-guarded,
50 MB cap); an inline export is re-read from the handoff file at the stored
`path`/`ref` (`404` if the file no longer carries it). URL wins when a handoff
has both; with neither there is no import. Chunked at 5 000 comments per pass.
Zero record loss, zero parent loss, idempotent on re-run. The response is the
import report (`received`, `mapped`, `inserted`, `skippedExisting`, `unmapped`,
`orphanCount`, …).

## Reading it

```
GET /api/workspaces/{ws}/projects/{p}/migration
```

```jsonc
{
  "present": true,
  "syncedAt": "2026-09-03T11:00:00.000Z",
  "summary": {
    "siteUrl": "https://carriedils.com", "generatedAt": "2026-09-03T10:00:00.000Z",
    "content": { "models": 7, "entries": 95, "locales": ["en"] },
    "capabilities": [{ "key": "comments", "disposition": "needs_runtime" }, …],
    "needsRuntime": ["comments", "forms"],
    "offers": [{ "capability": "comments", "provider": "studio_managed", "supported": true }, …],
    "comments": { "total": 1009, "hasExport": true, "source": "inline", "unresolved": 0 },
    "notes": ["…"],
    "issues": [{ "code": "runtime_unbound", "capabilities": ["comments", "forms"] }, { "code": "preview_url_missing" }]
  },
  "commentsImported": 0
}
```

## Contract notes for the Migrate side

- File name and place: `contentrain-handoff.json` at the project root (also
  accepted under the content root). Both are read; no other location is.
- `repository` and `preview_url` may be left empty; Studio fills `repository`
  at sync. `preview_url` is shown when present.
- `comments.export.inline` is fine for small sites; for large ones publish
  `comments.export.url` (it wins over inline). The URL must be `https` and
  resolve to a public address (private ranges and cloud metadata hosts are
  refused).
- `preview_url` and `runtime` are reported as issues when absent; Studio does
  not write `runtime` back yet.
