# Media Ingest from URLs

Move a site's images off their old host into Studio's media library and get
back the old → new URL map to rewrite content with. This is the migration
primitive behind "no reference points at the old host any more"; it is also
useful outside migrations (pull a batch of stock images, mirror a partner's
assets).

Requires the media stack (`ee/`, plan feature `media.upload`) and an active
CDN for delivery, exactly like a manual upload.

## Single URL

The MCP `contentrain_media_ingest` tool and the chat agent's `upload_media`
tool already ingest one URL each. Both go through `fetchRemoteMedia`
(`server/utils/media-ingest.ts`): SSRF guard (private, loopback, link-local and
cloud-metadata hosts are refused), MIME whitelist, per-plan size cap.

## Bulk

```
POST /api/workspaces/{workspaceId}/projects/{projectId}/media/bulk-ingest
Content-Type: application/json

{ "items": [ { "url": "https://old.example/wp-content/uploads/2020/05/hero.jpg", "alt": "Hero", "tags": ["blog"] }, … ],
  "concurrency": 3 }
```

- Up to **100 items per request**; duplicates collapse to one fetch.
- Concurrency 1–5 (default 3). Rate limit: 10 requests per user per minute.
- Roles: workspace owner/admin, or a member assigned to the project.
- Every item goes through the same fetch hardening, the atomic storage-quota
  reservation (reconciled to the optimized size), optimization and variant
  generation as a manual upload, and emits `media.uploaded` (with `sourceUrl`).
- **One failing URL never fails the batch.** Each item is reported on its own.

```jsonc
{
  "requested": 3, "unique": 2, "succeeded": 1, "failed": 1,
  "results": [
    { "url": "https://old.example/…/hero.jpg", "ok": true,
      "assetId": "…", "path": "media/original/….jpg",
      "deliveryUrl": "https://studio.example/api/cdn/v1/{projectId}/media/original/….jpg",
      "variantUrls": { "thumb": "…", "medium": "…" } },
    { "url": "https://old.example/…/gone.jpg", "ok": false, "error": "…", "statusCode": 400 }
  ],
  "map": { "https://old.example/…/hero.jpg": "https://studio.example/api/cdn/v1/{projectId}/media/original/….jpg" }
}
```

`map` is the rewrite table: replace each key in your content with its value.
`path` is what a media field stores (`media/original/…`); `deliveryUrl` is the
absolute URL a static site embeds.

Idempotency is per request only. Keep the returned map; re-sending a URL in a
later request creates a second asset. Retry exactly the `ok: false` items.

The Assets panel has an **Import from URLs** box (one URL per line) that
calls this endpoint and keeps the failed URLs in the box for a retry.

## Migration flow

1. Run `npx contentrain import <site> --out ./site` (or Contentrain Migrate) —
   the content lands in `.contentrain/`, media references still point at the
   old host.
2. Collect the referenced URLs and send them in batches of 100.
3. Rewrite the content with `map` (Migrate's runner does this; by hand,
   `contentrain_bulk` or a script over `.contentrain/content/**`).
4. Verify no reference points at the old host (the `@contentrain/verify`
   asset check when it ships; until then a grep for the old hostname).
