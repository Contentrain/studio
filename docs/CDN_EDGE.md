# CDN edge: Cloudflare in front of the delivery route

Studio serves content JSON and media from one route, `/api/cdn/v1/{projectId}/…`
(`server/api/cdn/v1/[projectId]/[...path].get.ts`), which reads from R2. Every
byte that route sends is Railway egress. Putting Cloudflare's cache in front of
it on a **separate host** keeps public media off the origin. The code in this
repo supports that host and limits and meters what the origin still sends.

Nothing here is required for a self-hosted deployment. Without the settings
below, behaviour is unchanged.

## Why a separate host

Only the CDN host is proxied through Cloudflare (orange cloud). The app host stays DNS-only:

- Chat streams (SSE) can outlive Cloudflare's 100-second response limit.
- Form, comment and login rate limits are per client IP. Behind a proxy, every
  visitor would share the edge's IP and one visitor could lock out the rest.
  On the CDN host this is solved by the `X-CR-Edge` secret (below). The app
  host does not need it.

## Operator steps (Cloudflare + Railway)

1. **Railway: add the CDN host.** Studio service → Settings → Networking →
   *Custom Domain* → `cdn.contentrain.io` (or your own). Railway shows the
   CNAME target; wait until its certificate is issued.
2. **Cloudflare DNS.** `CNAME cdn → <railway target>`, **Proxied** (orange
   cloud). Leave the app host's record DNS-only.
3. **SSL/TLS → Overview:** *Full (strict)*.
4. **Caching → Cache Rules → Create rule** "Studio CDN":
   - *When:* Hostname equals `cdn.contentrain.io` **and** URI Path starts with
     `/api/cdn/v1/` **and** Request Method equals `GET`.
   - *Then:* **Eligible for cache**; Edge TTL: **Use cache-control header if
     present**; Browser TTL: **Respect origin**.
   - The rule is needed because Cloudflare does not cache extensionless or JSON
     paths by default. Keyed responses are `private, max-age=60`, so Cloudflare
     still never stores them. Only keyless public media
     (`public, s-maxage=3600, stale-while-revalidate=86400`) is cached.
5. **Rules → Transform Rules → Modify Request Header → Create rule** "Studio edge
   marker":
   - *When:* Hostname equals `cdn.contentrain.io`.
   - *Then:* **Set static** header `X-CR-Edge` = a long random string, e.g.
     `openssl rand -hex 32`.
   - Keep the value secret. Anyone who has it can pick the client IP Studio's
     rate limits see.
6. **Studio environment (Railway variables), then redeploy:**
   ```
   NUXT_PUBLIC_CDN_URL=https://cdn.contentrain.io
   NUXT_CDN_EDGE_SECRET=<the same string as step 5>
   ```

## Verify

```bash
# Public media: second request should be a HIT
curl -sI https://cdn.contentrain.io/api/cdn/v1/<projectId>/media/<path> | grep -i -E 'cf-cache-status|cache-control'
curl -sI https://cdn.contentrain.io/api/cdn/v1/<projectId>/media/<path> | grep -i cf-cache-status   # HIT

# Keyed content JSON: never cached
curl -sI -H 'Authorization: Bearer crn_…' https://cdn.contentrain.io/api/cdn/v1/<projectId>/<model> | grep -i cf-cache-status   # DYNAMIC / BYPASS
```

In Cloudflare Analytics → Caching, aim for a hit ratio of **≥ 80 %** on the CDN
host in the first week.

## What changes in Studio when `NUXT_PUBLIC_CDN_URL` is set

- **New media URLs use the CDN host** (`publicMediaBase`). URLs already stored
  in content on the app host keep working, but they go to the origin uncached.
- **Moving existing projects:** `POST /api/workspaces/{ws}/projects/{id}/media/rehost`
  with `{ "from": { "siteUrl": "<app URL>", "projectId": "<same id>" }, "dryRun": true }`,
  then again without `dryRun`. This rewrites the app-host media URLs in content
  to the CDN host in one commit. The app host counts as this instance, so no
  asset copy is needed.
- **Client IP:** on a request carrying the right `X-CR-Edge`, rate limits use
  `CF-Connecting-IP` (`getClientIp`). Without the header, or with a wrong one,
  the existing rule applies (last `X-Forwarded-For` hop).
- **SDK and docs:** point the CDN base URL at the CDN host. The app-host route
  stays available: no cache, still limited and metered. Nothing breaks.

## Origin limit and meter

The origin's served bytes count against the plan's `cdn.bandwidth_gb`, per
workspace per calendar month. Cache hits never reach the origin and never count.

| Setting | Values | Default |
|---|---|---|
| `NUXT_CDN_ORIGIN_LIMIT` | `enforce`: past the plan limit delivery **continues** (usage alert + banner with the upgrade link); at **120 %** of the limit the origin answers **429** + `Retry-After` until the month resets, unless overage is on · `observe`: count and log, never refuse (self-hosters, operators) · `off` | `enforce` |
| `NUXT_CDN_ORIGIN_METER` | `true` sends one `cdn_origin_gb` event per workspace per finished UTC day to the payment meter | `false` |

`enforce` is the default on every deployment profile, dedicated and on-premise
included. An operator who wants to count without refusing sets `observe`
explicitly.

The owner hears about it through the usage alerts (`server/utils/usage-alerts.ts`),
once per workspace and month at each level:
- **80 %**: warning;
- **100 %**: "still being delivered, stops at 120 %", with the upgrade link;
- **120 %**: "delivery has stopped until …".

The in-app banner shows the same levels. The buffer caps what Studio pays past
a plan at 20 % of its transfer (`shared/utils/cdn-limit.ts`).

Rollout:
1. Do the Cloudflare steps above. With the cache in front, a normal site stays
   far below its origin limit.
2. Run polar-sync so the `cdn_origin_gb` meter exists, then set
   `NUXT_CDN_ORIGIN_METER=true`. Overage stays unsold (`overageBillable: false`)
   until the price decision (PR-F / ST-6).

## Rollback

- Remove `NUXT_PUBLIC_CDN_URL`. New media goes back to the app host, and CDN-host
  URLs already in content keep working as long as the DNS record stays.
- Turning the Cloudflare proxy off (grey cloud) keeps the host working, just
  uncached.
- `NUXT_CDN_ORIGIN_LIMIT=off` stops counting and refusing.
