# Contentrain Enterprise Edition

This directory contains proprietary feature implementations for Contentrain Studio.
All plans (Starter, Pro, Enterprise) include all features — EE provides the implementations.

## Structure

```
ee/
  cdn/             — CDN content delivery (Cloudflare R2, usage metering, rate limiting)
  enterprise/      — Enterprise bridge: webhooks, conversation API, AI keys, role normalization
  media/           — Media processing (Sharp image optimizer, variant generator, blurhash)
```

## How It Works

Feature implementations are loaded dynamically via `server/utils/enterprise.ts`:

```ts
// Core routes delegate to EE bridge — returns 403 if ee/ not present
await runEnterpriseRoute('listProjectWebhooks', 'webhook.upgrade', event)
```

Usage limits are enforced via `getPlanLimit()` in `shared/utils/license.ts`.
Core (AGPL) works without ee/ — EE routes return 403, core features unaffected.

## License

See [LICENSE](./LICENSE) — proprietary, not AGPL.
