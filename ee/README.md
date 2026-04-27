# Contentrain Enterprise Edition

This directory contains proprietary feature implementations for Contentrain Studio. It is licensed separately from the AGPL-3.0 core — see [`LICENSE`](LICENSE).

> **Edition is orthogonal to plan tier.** Whether the enterprise features are accessible at runtime depends on two independent checks: is `ee/` loaded (edition), and does the workspace's plan tier grant the feature (plan gate). Community Edition runs the same core without `ee/` and force-disables every `requires_ee: true` feature regardless of plan matrix values.

## Structure

```
ee/
  LICENSE          — proprietary, not AGPL (see Managed Use vs On-Premises grants)
  README.md        — this file
  cdn/             — Cloudflare R2 CDN provider + usage metering
  media/           — Sharp image processor + variant generator + blurhash
  enterprise/      — EnterpriseBridge surface: webhooks, conversation API,
                     BYOA key management, project-role normalization
```

## How the bridge is loaded

`server/utils/enterprise.ts` does a dynamic `import('../../ee/enterprise')` at boot (wrapped by `server/plugins/01.init-ee.ts`). If the import fails — for example in a Community Edition build where `ee/` has been excluded — the bridge resolves to `null` and the core degrades gracefully:

- `runEnterpriseRoute(handler, messageKey, event, featureKey?)` returns **403** when the bridge is `null`. When `featureKey` is supplied the plan gate runs first, so Starter customers on Managed hit 403 before the bridge is consulted.
- `normalizeEnterpriseProjectMemberAccess()` returns `{ role: 'editor', specificModels: false, allowedModels: [] }`.
- `resolveEnterpriseChatApiKey()` returns `null` (no BYOA path).
- `useCDNProvider()` / `useMediaProvider()` return `null`.

This means: every code path the AGPL core takes must tolerate a missing bridge. If you add a new `ee/` handler, the core call site must have a safe `null` or 403 fallback — it never short-circuits the product.

## Feature matrix

The authoritative plan × feature matrix lives in [`.contentrain/content/system/plan-features/`](../.contentrain/content/system/plan-features/). Each row carries `requires_ee: true|false`; the client-side `useFeature()` and server-side `hasFeature()` both apply the gate:

```
feature accessible  ⟺  matrix.plans.includes(plan) AND (!matrix.requires_ee OR edition === 'ee')
```

See [`docs/EDITIONS.md`](../docs/EDITIONS.md) for the full matrix and the orphan-feature cleanup rationale.

## Adding to ee/

1. Implement the functionality inside `ee/<domain>/`. External PRs to `ee/` are **not** accepted (see `ee/LICENSE` §5.3); contributions to the AGPL core go through the normal CLA/DCO path.
2. If it's exposed over HTTP, wire a core route in `server/api/...` that delegates to `runEnterpriseRoute(handlerName, messageKey, event, 'feature.key')`. The fourth argument is the plan gate — skip it only when the feature is edition-gated but plan-agnostic (rare).
3. Add a row to `.contentrain/content/system/plan-features/data.json` with `requires_ee: "true"` and the appropriate tier values. If the feature is advertised but unimplemented, also set `roadmap: "true"` so the UI renders a "Coming Soon" chip.
4. Run `npx contentrain generate` to refresh the SDK client types.
5. Extend the test matrix in `tests/unit/license-content-parity.test.ts` to pin the new row.

## License grants

`ee/LICENSE` defines five grant types:

- **Managed Use** — contentrain.io subscribers; grants use of `ee/` via the Managed Service only.
- **On-Premises Deployment** — separately executed order form; grants install + operate on customer infrastructure.
- **Evaluation** — 60 days, 1 instance, 5 users, non-production.
- **OEM / Embedded** — separate agreement required.
- **White-Label / Reseller** — separate agreement required.

See [`docs/LICENSING.md`](../docs/LICENSING.md) for the full SKU × license type × scenario table and `ee/LICENSE` for the controlling text.

## Upstream contact

- Licensing: `licensing@contentrain.io`
- Legal: `legal@contentrain.io`
- Commercial / on-prem support: `commercial@contentrain.io`
