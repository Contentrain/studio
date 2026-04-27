# Editions

Contentrain Studio ships in **two editions**, distinguished by whether the `ee/` directory is present and loaded at runtime. Edition is **orthogonal to plan tier**: a managed Enterprise customer and a self-hosted Community user see different UIs driven by different code paths, even though the plan-tier concept exists in both.

## Quick comparison

| | Community Edition | Enterprise Edition |
|---|---|---|
| **License** | AGPL-3.0 + `LICENSE-EXCEPTIONS` | AGPL core + `ee/LICENSE` (proprietary) |
| **`ee/` directory** | Absent or not loaded | Present and loaded (`loadEnterpriseBridge()` returns non-null) |
| **Billing** | Off | Polar / Stripe / flat-fee / off (operator choice) |
| **Plan tier (effective)** | `community` (fixed, unlimited) | `free` / `starter` / `pro` / `enterprise` (subscription-driven or operator-set) |
| **Supported scenarios** | 4 (community self-host), 6 (fork), 7 (reseller, core only), 11 (contributor), 12 (local eval) | 1 (managed SaaS), 2 (on-prem enterprise), 3 (managed dedicated), 5 (licensed self-host), 8 (OEM), 9 (white-label), 10 (air-gapped) |
| **Upgrade path** | Purchase subscription → install `ee/` → switch profile | N/A |

Edition detection happens at boot via `loadEnterpriseBridge()` (see `server/utils/enterprise.ts`); there is no separate environment flag.

## Community Edition — what works

The AGPL core is intended to be a **functional deployment**, not a teaser. The following feature set is available in Community Edition with **no numerical limits** (your infrastructure, your cost — limits are not enforced because there is no billing layer to meter them):

### Core platform (always available)
- Authentication: Supabase Auth with GitHub OAuth, Google OAuth, magic-link (whichever `ee/`-independent providers are configured)
- Workspace / project CRUD, team management (Owner / Admin / Member)
- GitHub App-based repository connection
- Content CRUD: collection, singleton, document, dictionary; 27 field types
- Content validation and health reporting
- Branch / diff / merge workflows, auto-merge (`workflow.review`)
- Multi-locale content (single and multi-locale both supported)
- Chat agent + all deterministic agent tools (content CRUD, validation, merge, brain, search)
- Forms (core): submission storage, captcha (Turnstile when configured), auto-approve, notifications, webhook notification
- AI chat with operator-provided `NUXT_ANTHROPIC_API_KEY`

### Not available in Community Edition

The following features require `ee/` and are **disabled** in Community Edition regardless of plan matrix values, enforced via `requires_ee: true` at `hasFeature()`:

- Studio-hosted AI key (`ai.studio_key`) — the Contentrain-managed Anthropic key
- Bring-your-own-API-key management UI (`ai.byoa`)
- Conversation API routes (`api.conversation`, `api.custom_instructions`, `api.conversation_keys`)
- Outbound webhooks (`api.webhooks_outbound`, `api.webhooks`)
- Media upload / library (`media.upload`, `media.library`) — CDN and media providers live in `ee/`
- CDN content delivery (`cdn.delivery`, `cdn.metering`)
- Project reviewer / viewer roles (`roles.reviewer`, `roles.viewer`) — roles degrade to `editor` without the bridge
- Model-specific access (`roles.specific_models`)
- Spam filter (`forms.spam_filter`)
- Form file uploads (`forms.file_upload`) — depends on media stack
- Form webhook notifications (`forms.webhook_notification`) — depends on outbound webhooks
- Media custom variants (`media.custom_variants`), per-field variant limit enforcement (`media.variants_per_field`)
- SSO (`sso.saml`, `sso.oidc`) — roadmap
- White-label branding (`branding.white_label`) — roadmap
- CDN preview branches (`cdn.preview_branch`), CDN custom domain (`cdn.custom_domain`) — roadmap
- MCP Cloud SSO (`api.mcp_cloud_sso`), custom domain (`api.mcp_cloud_custom_domain`) — roadmap

### Orphan features removed from the matrix

The following feature keys previously appeared in the plan matrix but had no enforcement and communicated no real plan differentiation; they are removed in favor of being implicit core behavior in all editions:

- `ai.agent` — the AI content agent itself (the product's core value)
- `git.connect` — GitHub App connection (core capability)
- `projects.create` — project creation (core flow)

These are not "features" in the plan sense; they exist in every Contentrain deployment.

## Enterprise Edition — what works

Enterprise Edition adds the `ee/` implementations of the EnterpriseBridge interface, plus feature gating by plan tier (Free / Starter / Pro / Enterprise). See [`.contentrain/content/system/plan-features/data.json`](../.contentrain/content/system/plan-features/data.json) for the authoritative plan × feature matrix, and `shared/utils/license.ts` for the runtime helper (`hasFeature`, `getPlanLimit`, `normalizePlan`).

The `requires_ee` flag on a feature row means: even if the plan matrix grants the feature for the current plan tier, the feature is only accessible when the enterprise bridge is loaded. This is an AND condition, not OR.

```
feature accessible  ⟺  plan tier grants feature AND (!requires_ee OR edition === 'ee')
```

## Plan tiers inside Enterprise Edition

| Plan | Price | Seats | Notes |
|---|---|---|---|
| `free` | $0 | 1 | Signup shell; 14-day trial of a paid plan is the developer conversion path |
| `starter` | $9/mo | 3 | Solo developer sizing |
| `pro` | $49/mo | 25 | Team sizing; full non-enterprise EE features |
| `enterprise` | custom | unlimited (per order form) | SSO, white-label, custom CDN domain, dedicated support |

The `community` tier is **Community Edition only** and is not for sale on the managed service. It is assigned automatically when `loadEnterpriseBridge()` returns `null`.

## Edition-specific UI behavior

| Surface | Community Edition | Enterprise Edition |
|---|---|---|
| Sidebar (`WorkspaceSwitcher`) plan badge | "Community" | Plan tier name ("Starter", "Pro", etc.) |
| `/settings` → Overview plan card | Read-only, "Community Edition" badge, tooltip explains self-hosted scope | Clickable, opens `PlanSelectionModal` |
| `/settings` → Billing tab | "Community Edition" info card, no subscription UI | Current plan + subscription controls + usage |
| Trial banner | Hidden (`billingState = 'subscribed'` in community) | Visible when trialing / past_due / free |
| AI Keys tab (BYOA) | Tab hidden (`requires_ee`) | Visible on Pro+ |
| Project Webhooks tab | Tab hidden (`requires_ee`) | Visible on Starter+ (within per-plan webhook limits) |
| Conversation API Keys tab | Tab hidden (`requires_ee`) | Visible on Pro+ |
| MCP Cloud tab | Tab visible (core endpoint) | Tab visible; advanced options (custom domain, SSO) Enterprise-gated |
| Members panel — role dropdown | Only `editor` shown | `editor` / `reviewer` / `viewer` per plan |

The full UI behavior is implemented via the `useDeployment()` composable (edition + plan + billing mode) and applied consistently across `WorkspaceSwitcher`, `WorkspaceOverviewPanel`, `WorkspaceBillingPanel`, `WorkspaceUsagePanel`, `WorkspaceMembersPanel`, `TrialBanner`, and `PlanSelectionModal`.

## Upgrade path (Community → Enterprise)

Community users who want enterprise features have two paths:

1. **Move to managed** — create a workspace on `contentrain.io`, migrate your content repository (already in Git), subscribe to a plan. No self-host code changes.
2. **License on-premises EE** — purchase an Enterprise Self-Managed order form, install the `ee/` directory at the same release tag as your AGPL core, set `NUXT_DEPLOYMENT_PROFILE=on-premise`, configure the plan per workspace. See [`DEPLOYMENT_PROFILES.md`](DEPLOYMENT_PROFILES.md).

There is no technical migration required — the same AGPL core runs in both cases.

## Related documents

- [`LICENSING.md`](LICENSING.md) — legal overview and SKU mapping
- [`DEPLOYMENT_PROFILES.md`](DEPLOYMENT_PROFILES.md) — 12 supported scenarios
- [`PAYMENT_PROVIDERS.md`](PAYMENT_PROVIDERS.md) — billing plugin registry
- [`SELF_HOSTING.md`](SELF_HOSTING.md) — Community Edition deployment guide
