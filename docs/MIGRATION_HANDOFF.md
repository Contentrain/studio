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
  contract's shape, `413` above 5 MB.
- **Enrichment**: `repository` is filled from the project (provider, owner,
  name, default branch) when Migrate could not know it.
- **Storage**: the validated document lives on `projects.migration_handoff`
  with `migration_handoff_synced_at` (migration `021_migration_handoff.sql`).
- **Overview card** (`MigrationHandoffCard`): source site, generation date,
  content summary, capabilities grouped by disposition (`needs_runtime`,
  `migrated_static`, `external_adapter`, `kept_on_wordpress`, `archived`,
  `dropped`), open offers, notes, and the comments state with a one-click
  import when the handoff carries an export.
- **Agent context**: a compact `## Migration (from WordPress)` block travels in
  the per-request context (never the cached system prompt) with a rule telling
  the agent which offers Studio can fulfil (comments, forms) and which it
  cannot yet (newsletter, e-commerce), so the first conversation on a migrated
  project starts from the manifest.

## Comments from the handoff

`POST /api/workspaces/{ws}/projects/{p}/migration/import-comments`
(owner/admin; plan features `comments.enabled` + `comments.import`) lands
`handoff.comments.export` through the same path as the manual upload
(`docs/COMMENTS.md`): inline export first, otherwise the export URL is fetched
server-side (SSRF-guarded, 50 MB cap) and chunked at 5 000 comments per pass.
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
    "offers": [{ "capability": "comments", "provider": "studio_managed" }, …],
    "comments": { "total": 1009, "hasExport": true, "unresolved": 0 },
    "notes": ["…"]
  },
  "commentsImported": 0
}
```

## Contract notes for the Migrate side

- File name and place: `contentrain-handoff.json` at the project root (also
  accepted under the content root). Both are read; no other location is.
- `repository` and `preview_url` may be left empty; Studio fills `repository`
  at sync. `preview_url` is shown when present.
- `comments.export.inline` is preferred for small sites; `comments.export.url`
  must be an `https` URL that resolves to a public address (private ranges
  and cloud metadata hosts are refused).
