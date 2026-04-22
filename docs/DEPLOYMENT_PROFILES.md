# Deployment Profiles

Contentrain Studio supports multiple deployment shapes that vary along four independent axes:

1. **Edition** — whether the `ee/` directory is loaded (Community vs Enterprise)
2. **Billing mode** — how subscription state is resolved (`off` / `polar` / `stripe` / `flat`)
3. **Plan source** — where the effective plan comes from (`subscription` / `operator` / `fixed`)
4. **Tenancy** — single workspace vs multiple workspaces

The `NUXT_DEPLOYMENT_PROFILE` environment variable (auto-detected when unset, explicit when set) selects a preset that configures these axes coherently. This document lists the supported presets, maps them to real-world scenarios, and gives per-scenario environment checklists.

> For feature-level behavior per edition, see [`EDITIONS.md`](EDITIONS.md). For legal mapping, see [`LICENSING.md`](LICENSING.md).

## Profiles

| Profile | Edition | Billing mode | Plan source | Default / fixed plan | Typical scenario |
|---|---|---|---|---|---|
| `managed` | ee (required) | polar or stripe | subscription | `free` (on signup) | 1 — Contentrain.io SaaS |
| `dedicated` | ee (required) | flat or polar | operator | `enterprise` | 3 — Managed dedicated for a single customer |
| `on-premise` | ee (required) | off | operator | `enterprise` | 2, 5, 10 — Customer runs `ee/` on their infra |
| `community` | agpl | off | fixed | `community` | 4, 6, 7, 11, 12 — AGPL-only self-host |

### Auto-detection (when `NUXT_DEPLOYMENT_PROFILE` is unset)

On boot, `resolveDeployment()` infers the profile from runtime signals:

| `ee/` loaded? | Polar/Stripe configured? | Inferred profile |
|---|---|---|
| Yes | Yes | `managed` |
| Yes | No | `on-premise` |
| No | any | `community` |

The `dedicated` profile must be **explicit** — auto-detection cannot distinguish it from `managed`. Set `NUXT_DEPLOYMENT_PROFILE=dedicated` when hosting a single tenant with flat-fee billing.

Explicit setting always wins over auto-detection. This is the override path for:

- running `managed` locally with billing disabled for development;
- running `community` when `ee/` exists on disk but must not be activated;
- pinning `on-premise` vs `dedicated` semantics.

## Scenarios — one-page checklist per scenario

### Scenario 1 — Managed SaaS (contentrain.io)

**Profile:** `managed` — multi-tenant, subscription-driven.

```bash
NUXT_DEPLOYMENT_PROFILE=managed            # explicit for clarity
NUXT_POLAR_ACCESS_TOKEN=polar_oat_…
NUXT_POLAR_WEBHOOK_SECRET=…
NUXT_POLAR_STARTER_PRODUCT_ID=…
NUXT_POLAR_PRO_PRODUCT_ID=…
NUXT_POLAR_SERVER=production
# billing flag is auto-set by the payment registry; no need to set NUXT_PUBLIC_BILLING_ENABLED
```

- `ee/` must be present and bundled with the image.
- Attribution (`LICENSE-EXCEPTIONS` §7(c)) — app footer and `/about` page must link to the public source repo for the deployed tag.
- AGPL-3.0 §13 source disclosure — satisfied by the public GitHub repo at the deployed tag.
- Webhooks from Polar → `POST /api/billing/webhook/polar` → upserts `payment_accounts` and syncs `workspaces.plan`.

### Scenario 2 — On-premise Enterprise (customer infra)

**Profile:** `on-premise` — customer runs the whole stack on their servers.

```bash
NUXT_DEPLOYMENT_PROFILE=on-premise
# No Polar / Stripe env vars — billing is off.
# Plan is set by the operator through DB or admin UI:
#   UPDATE workspaces SET plan = 'enterprise' WHERE id = '…';
# Default plan is 'enterprise' if workspace.plan is null.
```

- `ee/` must be present — licensed separately via `ee/LICENSE` §2.2.
- Authorized Users and Instance count per the executed order form.
- Webhooks disabled; usage metering outbox drains locally as a no-op.
- License key enforcement (offline) — [LAWYER REVIEW: offline key policy].

### Scenario 3 — Managed dedicated (single tenant hosted by Contentrain)

**Profile:** `dedicated` — one workspace, flat fee or custom subscription, hosted by Contentrain.

```bash
NUXT_DEPLOYMENT_PROFILE=dedicated
# Choose one billing flavor:
#   (a) flat fee → leave Polar/Stripe env vars unset, set plan via admin
#   (b) subscription → configure Polar like Scenario 1 but single-tenant
```

- Same `ee/` image as `managed`.
- Typically isolated database / DNS / secret scope per customer.
- Addendum in the order form clarifies scope.

### Scenario 4 — AGPL community self-host

**Profile:** `community` — AGPL core only, no managed billing.

```bash
NUXT_DEPLOYMENT_PROFILE=community
# No Polar / Stripe env vars.
# `ee/` must NOT be installed (or must be explicitly excluded from the deploy).
```

- All workspaces resolve to plan `community`. Numerical limits unenforced (unlimited).
- `requires_ee: true` features are hidden in the UI and 404 at the API.
- `NUXT_ANTHROPIC_API_KEY` (if configured by the operator) powers AI chat with the operator's own Anthropic account.
- Attribution (`LICENSE-EXCEPTIONS` §7(c)) and trademark (`LICENSE-EXCEPTIONS` §7(e)) obligations apply.
- AGPL-3.0 §13 — the operator must publish the corresponding source of the deployed tag (typically a link to the upstream repo, plus their own modifications if any).

### Scenario 5 — Licensed self-host (customer runs `ee/` on own infra)

Same profile and operational shape as Scenario 2 (`on-premise`). The difference is commercial: the customer is self-operating rather than receiving dedicated hosting from Contentrain.

### Scenario 6 — AGPL fork (competitor)

Same profile as Scenario 4 (`community`). `ee/` is not available under AGPL; a fork that includes `ee/` without an executed agreement violates `ee/LICENSE` §3.3 and §3.4. Fork operators must also:

- Rebrand per `LICENSE-EXCEPTIONS` §7(e) — the "Contentrain" name and logos cannot be used for the fork's product identity.
- Satisfy AGPL §13 independently — publish their corresponding source.

### Scenario 7 — Hosting reseller (core only)

Same profile as Scenario 4 (`community`). Reselling the EE is prohibited; reselling the AGPL core as a paid service is permitted subject to AGPL §13 and the `LICENSE-EXCEPTIONS` §7(e) trademark rule. A commercial agreement with Contentrain is recommended for support, trademark use, or offering EE features to reseller customers.

### Scenario 8 — OEM embedded

**Profile:** `managed` or `dedicated` depending on the OEM contract.

Requires a separately executed OEM agreement (`ee/LICENSE` §2.4). The OEM contract specifies:
- which EE features are exposed;
- whether the OEM's customers are counted as Authorized Users;
- attribution and branding rules;
- AGPL §13 compliance ownership (the OEM typically takes this on).

### Scenario 9 — White-label partner

**Profile:** `dedicated` (most common).

Requires a separately executed white-label agreement (`ee/LICENSE` §2.5). The white-label contract grants limited trademark rights to rebrand the EE. The AGPL core's `LICENSE-EXCEPTIONS` §7(c) attribution can be relaxed only by written permission in the contract.

### Scenario 10 — Air-gapped enterprise on-premise

**Profile:** `on-premise` with additional operational constraints.

```bash
NUXT_DEPLOYMENT_PROFILE=on-premise
# All outbound-network-dependent features must be disabled or configured for internal mirrors:
# - Polar / Stripe env vars unset (billing off)
# - Resend disabled (email sending off, or configured for internal SMTP)
# - Anthropic key optional (configure with internal proxy if needed)
# - GitHub App can be replaced by a GitHub Enterprise Server instance
```

- License key must support offline validation with grace period — [LAWYER REVIEW: offline policy].
- Usage metering outbox accumulates rows but never drains (no outbound webhooks).
- Auto-update cadence is manual — customer pins to a specific release tag and upgrades on their schedule.

### Scenario 11 — Contributor (AGPL core PR)

Any profile can be used locally. AGPL-3.0 applies to all contributions to the core. Contributions to `ee/` are not accepted from external parties (`ee/LICENSE` §5.3).

### Scenario 12 — Local evaluation

Typically `community` (no `ee/`) or an Evaluation License (`ee/LICENSE` §2.3 — 60 days, 1 instance, 5 users, non-production).

```bash
pnpm install
pnpm db:start           # local Supabase
pnpm db:migrate
pnpm dev                # auto-detects community
```

## Environment variables by profile

| Variable | `managed` | `dedicated` | `on-premise` | `community` |
|---|---|---|---|---|
| `NUXT_DEPLOYMENT_PROFILE` | set / auto | set explicitly | set / auto | set / auto |
| `NUXT_SESSION_SECRET` | required | required | required | required |
| `NUXT_SUPABASE_*` | required | required | required | required |
| `NUXT_GITHUB_APP_*` | required | required | required | required (if using GitHub) |
| `NUXT_POLAR_*` | required | optional (flat fee ok) | — | — |
| `NUXT_STRIPE_*` | optional fallback | optional | — | — |
| `NUXT_PUBLIC_BILLING_ENABLED` | auto-set true by registry | auto-set | auto-set false | auto-set false |
| `NUXT_RESEND_*` | recommended | recommended | optional | optional |
| `NUXT_CDN_R2_*` | optional (EE media) | optional | optional | — (EE feature) |
| `NUXT_ANTHROPIC_API_KEY` | optional (Studio-hosted key) | optional | optional | required for AI chat |

All profiles share the same base requirements (session secret, database, auth, GitHub). Only billing / EE feature envs differ.

## Verifying your profile at runtime

The effective deployment state is exposed to the client at runtime via `useRuntimeConfig().public.deployment`:

```ts
const { public: { deployment } } = useRuntimeConfig()
// { profile: 'managed', edition: 'ee', billingMode: 'polar' }
```

Server code uses `resolveDeployment()` directly from `server/utils/deployment.ts`. The values are computed once at boot in `server/plugins/00.billing-flag.ts` and do not change per request.

## Related documents

- [`LICENSING.md`](LICENSING.md) — legal overview
- [`EDITIONS.md`](EDITIONS.md) — Community vs Enterprise feature matrix
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — general deployment topology
- [`SELF_HOSTING.md`](SELF_HOSTING.md) — Community Edition guide
- [`PAYMENT_PROVIDERS.md`](PAYMENT_PROVIDERS.md) — billing plugin registry
- [`DOCKER.md`](DOCKER.md) — image and tag policy
