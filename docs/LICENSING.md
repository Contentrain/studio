# Licensing Overview

Contentrain Studio is distributed under an **open-core** model. This document explains what is licensed under what, how the two licenses relate, and which license applies to each supported deployment scenario.

> This document is a practical guide, not a legal contract. For the controlling text, see [`LICENSE`](../LICENSE), [`LICENSE-EXCEPTIONS`](../LICENSE-EXCEPTIONS), and [`ee/LICENSE`](../ee/LICENSE). For legal inquiries, contact `legal@contentrain.io`.

## Licenses in this repository

| Directory | License | Governs |
|---|---|---|
| Repository root (`app/`, `server/`, `supabase/`, `.contentrain/`, tests, config, docs) | **AGPL-3.0-only** with §7 additional terms in `LICENSE-EXCEPTIONS` | Community core; self-hosting, forking, commercial hosting all permitted subject to AGPL-3.0 §13 source-disclosure and the attribution/trademark terms in `LICENSE-EXCEPTIONS` |
| `ee/` | **Contentrain Enterprise Edition License v1.0** (see `ee/LICENSE`) | Proprietary; use requires a Contentrain Subscription or a separately executed commercial agreement |

Third-party open-source components and their licenses are declared in the package manifests (`package.json`, `pnpm-lock.yaml`).

## How the two licenses interact

- The Enterprise Edition (`ee/`) is **not** licensed under the AGPL-3.0.
- `ee/` code communicates with the AGPL core only through defined interfaces (`EnterpriseBridge`, provider interfaces). This interaction is an **aggregate** under AGPL-3.0 §5 and does not convert `ee/` into AGPL-covered software.
- The AGPL core continues to function without `ee/` (the "Community Edition"). When `ee/` is absent, `loadEnterpriseBridge()` returns `null` and enterprise features degrade gracefully.
- The `LICENSE-EXCEPTIONS` §7 terms (attribution + no-trademark) apply to the AGPL core only; they do not modify `ee/LICENSE`.

## Plan / SKU → License mapping

| Plan / SKU | License type (ee/LICENSE §2) | Instance limit | Authorized users | Production use | Notes |
|---|---|---|---|---|---|
| **Community** (AGPL-only self-host) | None needed for `ee/` (EE not used) | Unlimited (your infra, your cost) | Unlimited | Permitted | AGPL-3.0 §13 applies; attribution required (`LICENSE-EXCEPTIONS` §7(c)) |
| **Free** (managed, contentrain.io) | Managed Use (§2.1) | N/A (hosted) | Per tier | Permitted | Managed Service account only |
| **Starter** (managed, $9/mo) | Managed Use (§2.1) | N/A (hosted) | Per tier | Permitted | EE features gated by plan flags |
| **Pro** (managed, $49/mo) | Managed Use (§2.1) | N/A (hosted) | Per tier | Permitted | Full EE feature set (non-enterprise) |
| **Enterprise (Cloud)** (managed, custom) | Managed Use (§2.1) + dedicated addendum | N/A (hosted) | Per order form | Permitted | SSO, white-label, SLA, custom limits |
| **Enterprise (Self-Managed)** (on-prem) | On-Premises Deployment (§2.2) | Per order form | Per order form | Per order form | Separate written agreement required |
| **Evaluation** | Evaluation License (§2.3) | 1 | 5 | Non-production only | 60 days max |
| **OEM / Embedded** | OEM License (§2.4) | Per agreement | Per agreement | Per agreement | Separate OEM contract |
| **White-label / Reseller** | White-Label License (§2.5) | Per agreement | Per agreement | Per agreement | Separate reseller contract |

The legacy "Business" SKU is superseded and has no effect (`ee/LICENSE` §1.5).

## Supported deployment scenarios

Contentrain Studio recognizes the following deployment shapes. Each scenario is a combination of *edition* (AGPL core only vs core + `ee/`) and *billing mode* (managed / operator-set / none). The licensing requirement below follows from that combination.

| # | Scenario | Core license | `ee/` license type | Required documents |
|---|---|---|---|---|
| 1 | **Managed SaaS** (contentrain.io, multi-tenant) | AGPL-3.0 (operated by Contentrain) | Managed Use §2.1 | Subscription |
| 2 | **On-premise Enterprise** (customer infra) | AGPL-3.0 | On-Premises Deployment §2.2 | Enterprise Self-Managed order form |
| 3 | **Managed dedicated** (single tenant hosted by Contentrain) | AGPL-3.0 | Managed Use §2.1 + dedicated addendum | Enterprise Cloud order form |
| 4 | **AGPL community self-host** (no `ee/`) | AGPL-3.0 + `LICENSE-EXCEPTIONS` | None (EE not used; do not install `ee/` without a license) | AGPL-3.0 only |
| 5 | **Licensed self-host** (customer runs `ee/` on own infra) | AGPL-3.0 | On-Premises Deployment §2.2 | Enterprise Self-Managed order form |
| 6 | **AGPL fork** (competitor, no `ee/`) | AGPL-3.0 + `LICENSE-EXCEPTIONS` | Not granted; `ee/` must not be used | AGPL-3.0; attribution + no-trademark apply; §13 network source disclosure |
| 7 | **Hosting reseller** (core only, multi-customer) | AGPL-3.0 + `LICENSE-EXCEPTIONS` | Not granted; reselling `ee/` prohibited (§3.3, §3.4) | AGPL-3.0; commercial agreement recommended for support/trademark |
| 8 | **OEM embedded** (Contentrain inside another product) | AGPL-3.0 (note §13 aggregate effects) | OEM License §2.4 | Separate OEM agreement |
| 9 | **White-label partner** (rebrand) | AGPL-3.0 (no trademark grant) | White-Label License §2.5 | Separate white-label agreement |
| 10 | **Air-gapped on-premise** (offline, no webhooks) | AGPL-3.0 | On-Premises Deployment §2.2 + air-gap addendum | Enterprise Self-Managed + air-gap rider |
| 11 | **Contributor** (PR to AGPL core) | AGPL-3.0 + CLA/DCO as published in the repo | Not applicable (`ee/` accepts no external PRs, §5.3) | Repository CLA/DCO |
| 12 | **Local evaluation** (developer trial) | AGPL-3.0 | Evaluation License §2.3 | 60 days, 1 instance, 5 users, non-production |

## AGPL-3.0 §13 source-disclosure obligation (for network operators)

If you operate a modified version of the AGPL core as a **network service** (including managed SaaS, hosting reselling, OEM embedded, or any case where end users interact with the software remotely), AGPL-3.0 §13 requires you to offer those users access to the Corresponding Source.

Contentrain Studio satisfies this obligation on `contentrain.io` by:

- publishing the unmodified AGPL core on <https://github.com/Contentrain/studio> for the release tag that is deployed;
- exposing a visible "Source" link in the application footer and on the `/about` page that points to the corresponding source;
- making modifications (if any) to the deployed tag available in the same public repository or a clearly linked fork.

If you operate your own deployment (scenarios 1, 3, 5, 7, 8, 9, 10), you must satisfy §13 independently for your deployment. The attribution requirement in `LICENSE-EXCEPTIONS` §7(c) is designed to make this visible to your end users.

## Edition detection (how the runtime decides)

- **Community Edition** — `ee/` directory absent, or the enterprise bridge fails to load (`loadEnterpriseBridge()` returns `null`). All `ee/`-dependent features are disabled; the plan tier is fixed to `community`.
- **Enterprise Edition** — `ee/` directory present and `loadEnterpriseBridge()` returns a bridge instance. Plan tier is determined by the deployment profile (subscription-driven, operator-set, or fixed).

The deployment profile is set by the `NUXT_DEPLOYMENT_PROFILE` environment variable, with auto-detection fallback. See [DEPLOYMENT_PROFILES.md](DEPLOYMENT_PROFILES.md) for the full matrix.

## License enforcement (runtime)

- **Managed Service:** subscription state flows from the active payment provider (Polar by default) into `payment_accounts`, then into `workspaces.plan`. Feature access is checked via `hasFeature(plan, 'feature.name', { edition })`.
- **On-Premises Deployment:** plan is set by the operator on `workspaces.plan` (or fixed by `NUXT_DEPLOYMENT_PROFILE=dedicated|on-premise`). Offline license-key enforcement (signed JWT + expiration + grace period for air-gapped deployments) is a roadmap item for a later Enterprise Edition release — see `ROADMAP.md`. v1.0 deployments rely on the executed order form + audit rights in `ee/LICENSE` §6.2 as the enforcement mechanism.
- **Community Edition:** plan is fixed to `community` and `requires_ee` features are force-disabled at `hasFeature()`.

## Commercial contact

| Topic | Contact |
|---|---|
| General licensing questions | `licensing@contentrain.io` |
| Legal notices | `legal@contentrain.io` |
| OEM / white-label / reseller agreements | `licensing@contentrain.io` |
| Commercial support / SLA | `commercial@contentrain.io` |
| Security disclosures | see [`SECURITY.md`](../SECURITY.md) |

## Related documents

- [`LICENSE`](../LICENSE) — AGPL-3.0 core license text
- [`LICENSE-EXCEPTIONS`](../LICENSE-EXCEPTIONS) — AGPL-3.0 §7 additional terms (attribution, no-trademark)
- [`ee/LICENSE`](../ee/LICENSE) — Enterprise Edition License (proprietary)
- [`NOTICE`](../NOTICE) — dual-license index for source-distribution recipients
- [`EDITIONS.md`](EDITIONS.md) — Community vs Enterprise Edition feature matrix
- [`DEPLOYMENT_PROFILES.md`](DEPLOYMENT_PROFILES.md) — 12 supported scenarios with profile + env guidance
