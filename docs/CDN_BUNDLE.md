# CDN Locale Bundle (`_bundle/{locale}.json`)

The CDN build emits one bundle artifact per locale so a client can prime its
per-path cache with a single conditional fetch instead of N per-model requests
(one per collection/singleton/dictionary, plus one per `include()` relation).

## Why

`@contentrain/query`'s CDN transport fetches each model as its own request and
resolves `include()` relations with additional requests — a typical page render
costs 5–10+ round-trips, each paying full origin latency. Content only changes
on a CDN build, so all of those bodies can ship together.

## Contract (v1)

`GET {baseUrl}/{projectId}/_bundle/{locale}.json`

- **Auth:** keyed-only (`Authorization: Bearer crn_...`) — same class as
  content JSON. Never publicly served.
- **Caching:** ETag'd like every delivery object; clients revalidate with
  `If-None-Match`.

```jsonc
{
  "version": "1",
  "commitSha": "abc123...",
  "builtAt": "2026-07-10T12:00:00.000Z",
  "locale": "en",
  "paths": {
    // Keys are the EXACT delivery paths the SDK already fetches.
    // Bodies are identical to the standalone artifacts.
    "content/authors/en.json":           { "<id>": { /* entry */ } },
    "content/site-settings/data.json":   { /* singleton body */ },
    "documents/articles/_index/en.json": [ /* frontmatter index */ ]
  }
}
```

### Scope rules

- All JSON-kind models (collections published-filtered, singletons,
  dictionaries) ship with their full body.
- **Non-i18n models** appear under their real path (`content/{id}/data.json`)
  in **every** locale bundle.
- Document models contribute only their `_index`; per-slug bodies
  (`documents/{m}/{slug}/{locale}.json`) and `meta/...` are **not** bundled and
  fall through to normal per-path fetches.
- Consumers must ignore bundles whose `version` is not `"1"` or whose `paths`
  is missing (treat as absent and fall back to per-path fetches).

### Build behavior

- Emitted on **every** build (full and selective) by
  `server/utils/cdn-builder.ts`, so the bundle always mirrors the standalone
  artifacts.
- Selective builds fill unchanged models from the artifacts already in CDN
  storage — zero extra git traffic. A missing artifact is skipped and heals on
  the next full rebuild.
- A selective build that touches no models skips bundle emission (content
  unchanged → existing bundles are still current).

## Consumption

### Raw fetch (works today)

```ts
const res = await fetch(`${base}/${projectId}/_bundle/en.json`, {
  headers: { Authorization: `Bearer ${apiKey}` },
})
const { paths } = await res.json()
const authors = paths['content/authors/en.json']
```

### `@contentrain/query` preload mode (SDK-side, planned)

`createContentrain({ bundle: true })` — the transport lazily fetches
`_bundle/{locale}.json` once per `revalidateMs` window (default 60s,
conditional — a 304 keeps the primed data), primes its per-path cache, and
serves primed paths without network. Unprimed paths (document bodies, meta,
media manifest) keep their existing per-path behavior. A 404 (bundle not yet
built) falls back to per-path fetches, so the SDK feature is safe to ship
before/independently of this artifact.
