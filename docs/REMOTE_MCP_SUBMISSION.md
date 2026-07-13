# Remote MCP — Directory Submission Runbook (internal)

Operator playbook for listing Studio's remote MCP endpoint
(`https://studio.contentrain.io/api/mcp/remote`) in the **Claude
Connectors Directory** and the **OpenAI Plugin directory** (covers
ChatGPT + Codex). User-facing docs live in [REMOTE_MCP.md](./REMOTE_MCP.md).

> Requirements below were re-verified against official docs on 2026-07-13
> (claude.com/docs/connectors, developers.openai.com/apps-sdk,
> modelcontextprotocol.io). Two things changed since the first draft — see
> **What changed** at the bottom. The live discovery/auth surface was
> smoke-tested against the staging origin the same day; results are inline.

> **The origin is contractual.** OpenAI treats a change of scheme/host/port
> as a brand-new app (domain verification + `callback_id` are host-bound);
> Claude's URL slug is **permanent once published** and the PRM `resource`
> string must match the entered URL exactly, incl. path. Submit with the
> production origin only — never staging — and never change the PRM
> `resource` string or the AS `issuer` after listing.

## 0. Status at a glance (2026-07-13)

| Area | State |
|------|-------|
| OAuth discovery — PRM (RFC 9728), ASM (RFC 8414), 401 + `WWW-Authenticate` | ✅ live on staging |
| **CIMD** advertised (`client_id_metadata_document_supported: true`, `none` auth, PKCE `S256`) | ✅ live — this is the **primary** method both platforms now prefer |
| DCR (RFC 7591) fallback endpoint | ⚠️ exists but **500s until migrations run** (see §2.1) |
| OpenAI domain-challenge route at apex root (`/.well-known/openai-apps-challenge`) | ✅ present (404 until `NUXT_OPENAI_APPS_CHALLENGE` set — correct) |
| Reviewer no-OAuth login (`/auth/review-login`) | ✅ built (#144) — this is the hard requirement, already covered |
| Tool annotations (`openWorldHint`, `title`, read/write split) | ✅ in `@contentrain/mcp` 1.10.0 |
| Server `instructions` | ✅ 1.10.0 ships a strong default |
| **Prod origin permanent + migrated** | ❌ **the gating work** (§2.1, §Deploy) |
| Org prerequisites + legal URLs | ❌ operator/business, weeks of lead — start first (§1) |

## 1. Organizational prerequisites (weeks of lead time — start first)

- [ ] **Claude**: **Team or Enterprise** org. Submission portal lives at
      `claude.ai/admin-settings/directory/submissions/new`. By default only
      org **Owners** submit; on Enterprise an Owner can delegate a custom
      role with the **Directory management** permission (Team plans have no
      custom roles → stays with Owners). Escalations: `mcp-review@anthropic.com`.
- [ ] **OpenAI**: organization (or individual) **verification** under the
      publishing name in the Platform Dashboard, the **`api.apps.write`**
      permission, and a **global-residency** project — **EU-residency
      projects cannot submit** plugins for review.
- [ ] Public **docs URL**, **privacy policy URL**, **support contact** live
      on contentrain.io (both forms require all three; on Claude a
      missing/incomplete privacy policy is an **immediate rejection**).
      Drafts are in `scratchpad/mcp-submission/legal-pages.md` — move to real
      pages, complete every `[PLACEHOLDER]`, and legal-review every claim.

## 2. Technical prerequisites (this repo)

- [x] Discovery chain answers on the origin — verified on staging:
      `GET /.well-known/oauth-protected-resource/api/mcp/remote` → 200 (PRM
      `resource` = the endpoint, `authorization_servers[0]` = origin);
      `GET /.well-known/oauth-authorization-server` → 200 (issuer +
      register/authorize/token, `code_challenge_methods_supported: ["S256"]`,
      `client_id_metadata_document_supported: true`); bare
      `POST /api/mcp/remote` → 401 + `WWW-Authenticate: Bearer …
      resource_metadata="…" scope="…"`. Anthropic egress is `160.79.104.0/21`.
- [ ] Production runs the managed pair with
      `NUXT_PUBLIC_SITE_URL=https://studio.contentrain.io`.
- [ ] **OpenAI domain verification**: the verifier fetches the challenge at
      the **apex root** (`https://studio.contentrain.io/.well-known/openai-apps-challenge`)
      and strips any subpath — Studio serves this route at the host root, so
      the subpath MCP path is fine. Set `NUXT_OPENAI_APPS_CHALLENGE` to the
      portal token; confirm the file serves it; unset after verification.
- [x] **Review account**: `/auth/review-login` is a password login with no
      OAuth/MFA/email step (OpenAI + Claude hard requirement) — built in #144.
      Set `NUXT_REVIEW_ACCOUNT_EMAIL` + `NUXT_REVIEW_ACCOUNT_PASSWORD`
      (≥16 chars) for the review window on a **fully-populated** workspace:
      connected repo with real content models/entries, plan that includes
      `api.mcp_cloud_oauth`, GitHub App installed, media stack if you want
      the `media:*` tools reviewed. Rotate/unset after each cycle.

### 2.1 Migrations — the one hard technical blocker

**The OAuth server tables (`016_oauth_server.sql` → `auth.oauth_clients`,
`oauth_grants`, `oauth_authorization_codes`, `oauth_access_tokens`,
`oauth_refresh_tokens`) plus `017`/`018` must be applied to the target
database BEFORE the connector will work.** Symptom when they are missing:
the static discovery endpoints answer fine, but `POST /oauth/register`
(DCR) and the `authorize→code→token` write path **500** — observed on
staging 2026-07-13, root cause = `016` never applied. All of DCR **and**
CIMD depend on these tables (both write grants/codes/tokens).

**Managed-pair deploys do NOT auto-run migrations** (`railway.toml`
startCommand is just the server). Apply them explicitly, **staging then
prod, migrations before the new image** (RELEASING.md §Database and
Migration Order). The runner is idempotent (tracks `public.schema_migrations`,
each file in its own transaction, advisory-locked): re-runs are no-ops.

`.env.staging` / `.env.prod` are **not usable locally** — `NUXT_POSTGRES_URL`
is a Railway reference (`${{Postgres.DATABASE_URL}}`) or the private
`postgres.railway.internal` host, neither reachable off-Railway. Two ways to
apply:

1. **One-off from the Railway public proxy** (fastest to unblock): copy the
   Postgres service's **public** URL (Railway → Postgres → Variables →
   `DATABASE_PUBLIC_URL`, or the Connect tab), then from the repo root:
   ```bash
   node scripts/migrate-postgres.mjs --url "<DATABASE_PUBLIC_URL>"
   node scripts/verify-managed-schema.mjs --url "<DATABASE_PUBLIC_URL>"   # if it accepts --url; else set NUXT_POSTGRES_URL
   ```
   Do NOT paste the URL into shared logs. Repeat for the prod Postgres.
2. **Permanent fix — run inside Railway on every deploy** (recommended, and
   it satisfies "migrations before image"): add a **Pre-Deploy Command** to
   each Railway service (staging + prod) = `node scripts/migrate-postgres.mjs`.
   Inside Railway `NUXT_POSTGRES_URL` resolves to the internal DB and the
   role has DDL rights, so migrations apply before the new release serves; a
   failed migration fails the deploy (fail-safe). Confirm the exact config
   key against current Railway docs before wiring it into `railway.toml`.

**After applying, re-test:** `POST /oauth/register` → **201 + `client_id`**
(the §4 matrix's automatable step), then walk the full consent flow.

## 3. Upstream `@contentrain/mcp` checklist — CLOSED in 1.10.0

Studio now pins `@contentrain/mcp` **1.10.0**. Prior open items are resolved:

- [x] `title` on every tool; `readOnlyHint` / `destructiveHint` correct
      (delete tools carry `destructiveHint: true`); names ≤ 64 chars.
- [x] **`openWorldHint` present** (required by OpenAI, not Claude) — 1.10.0
      annotates it; `media_ingest` is the only open-world tool.
- [x] **Server `instructions`** — 1.10.0 ships a strong `DEFAULT_INSTRUCTIONS`
      ("Contentrain is git-native content governance…") surfaced at
      initialize; override via `CreateServerOptions.instructions` only if you
      want a submission-specific string (OpenAI snapshots it at scan time).
- [x] **`sessionFingerprint`** wired in Studio (`mcp-cloud-server.ts` →
      `mcpTenantFingerprint`); `TOOL_REQUIREMENTS` drives the media
      scope→tool map.
- [ ] Optional: `destructiveHint: true` for `contentrain_bulk` (upstream
      judgment call — not a blocker; `bulk` isn't exposed over the connector
      anyway).
- [ ] After any future MCP bump: diff the git internals + do a real staging
      content save before trusting the mocked suite. Note OpenAI's Scan-Tools
      contract (§6) — a bump that changes tool names/descriptions/schemas/
      annotations/instructions forces an OpenAI **version resubmission**;
      batch MCP upgrades around that cycle.

## 4. Manual test matrix (run on staging first, then production origin)

CIMD is the primary path; DCR is the fallback (Codex, and Claude when CIMD
selection fails). Run §2.1 migrations first or steps 2–9 will 500.

| # | Client | Steps | Pass criteria |
|---|--------|-------|---------------|
| 1 | MCP Inspector | Point at `/api/mcp/remote`; walk discovery → CIMD/register → consent → `tools/list`; exercise EVERY tool once | Each tool returns a non-generic response; Claude submission requires confirming this |
| 2 | Claude custom connector | Settings → Connectors → add the URL | Connect card appears from the bare 401; consent shows the client host; tools run |
| 3 | Claude Code | `claude mcp add --transport http contentrain <url>` | RFC 8252 loopback callback works (port-agnostic redirect match) |
| 4 | ChatGPT developer mode | Add MCP server in Settings → Connectors/Plugins | CIMD/DCR registration + consent complete; tools listed |
| 5 | Codex | `[mcp_servers.contentrain]` in config.toml → `codex mcp login contentrain` | DCR path completes; tools run |
| 6 | Scope step-up | Connect read-only, call `contentrain_content_save` | 403 `insufficient_scope` → client re-prompts consent → retry succeeds |
| 7 | Refresh rotation | Stay connected > 1h, call a tool | Silent refresh; no re-auth prompt |
| 8 | Revocation | Disconnect in Settings → Connected Apps | Client's next call prompts a clean re-authorization |
| 9 | Write path | `contentrain_content_save` on a test project | `cr/*` branch lands + auto-merge reconcile fires (or waits on review-gated projects) |

## 5. Claude submission (claude.ai → Admin settings → Directory)

1. Run the [pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria).
   Key rejection rules: every tool needs `title` + `readOnlyHint`/
   `destructiveHint`; **read and write must be separate tools** (a catch-all
   `api_request` with a `method` param is auto-rejected — Studio's surface is
   already split); first-party APIs only; no money transfer; privacy policy
   mandatory.
2. Portal steps (`…/directory/submissions/new`): Introduction, Connection
   (production URL, streamable HTTP, "same URL for every user"), Tools sync,
   Listing (**name ≤100, tagline ≤55, description ≤2000, 1–5 categories**,
   docs + privacy URLs, support contact, icon, **permanent slug**; MCP-UI
   apps also need 3–5 PNG screenshots ≥1000px), Use cases, Company,
   Authentication (**OAuth — CIMD primary, DCR fallback**; both out-of-the-box),
   Data handling (first-party API), Test & launch (review-account creds +
   step-by-step access + confirm every tool exercised), seven compliance
   acknowledgments. Copy drafts: `scratchpad/mcp-submission/listing-copy.md`.
3. Listings start as **community connector** (automated scan); Anthropic
   **auto-escalates** standout ones to **verified** (functional per-tool
   testing) — no action needed. Timelines vary with queue; no SLA.

## 6. OpenAI submission (Plugin directory — one submission covers ChatGPT + Codex)

> Since **2026-07-09** the "app directory" is the **Plugin directory**; a
> plugin bundles skills + apps + templates and surfaces across ChatGPT
> web/desktop, ChatGPT Work, and Codex. The submission page is
> `developers.openai.com/apps-sdk/deploy/submission`.

1. Verify the domain (`NUXT_OPENAI_APPS_CHALLENGE`, §2) — apex root.
2. Create the plugin draft → add MCP server details → **Scan Tools**. This
   **snapshots** tool names/titles/descriptions/schemas/security schemes/
   `_meta`/annotations/UI-resource-CSP/**server instructions** into a
   versioned contract. Changing any of these later = new draft version →
   re-scan → resubmit. **Only one version published and one in review at a
   time** (withdraw via Cancel Review). Server-only fixes that preserve the
   contract don't need resubmission.
3. Auth: **CIMD preferred** (our AS advertises it); DCR supported as
   fallback. Per-app redirect URI is `https://chatgpt.com/connector/oauth/{callback_id}`
   (generated per app instance, shown on the app management page) — self-serve
   via CIMD/DCR, nothing to pre-register.
4. Provide: app name/logo/description, company + privacy URLs, review
   credentials (§2 — **no MFA/SMS/email**, must work off-LAN), test prompts
   with expected responses (reviewers verify on **web AND mobile**),
   **per-annotation justification** (`openWorldHint`/`destructiveHint`/
   `readOnlyHint`). Justifications table: `scratchpad/mcp-submission/listing-copy.md` §E.
5. After approval, publish from the portal.

## 7. Post-listing invariants

- Never change the PRM `resource` string, the AS `issuer`, or the endpoint
  origin (scheme/host/port). A host change = new OpenAI app + broken Claude
  discovery cache; the Claude slug is permanent.
- Discovery documents are cached ~5 min globally by Claude; scope changes
  propagate on that horizon.
- Loopback MCP sessions are per-instance (15 min TTL): keep a single replica
  or sticky sessions in front of `/api/mcp/remote`.
- Prefer **CIMD** over DCR at directory scale — DCR registers a fresh client
  per connection. Our AS advertises CIMD; keep it advertised.
- Tool-surface changes (names/descriptions/schemas via an MCP bump) require
  an OpenAI **version resubmission** — batch them; Claude re-syncs tools
  automatically but the same annotation rules re-apply.
- Migrations run before every deploy (§2.1) — never ship an image ahead of
  its schema.

## What changed since the first draft (2026-07-13 re-verification)

1. **OpenAI "app" → "Plugin" directory** (2026-07-09). Terminology + the
   plugin-bundles-skills/apps/templates model; one submission still covers
   ChatGPT + Codex (Codex adds its own runtime permission controls).
2. **CIMD is now the preferred auth on both platforms**; DCR is discouraged
   at directory scale (fresh client per connection). Studio already
   advertises CIMD — no change needed, but lead with it in both portals.
3. All 8 original runbook claims re-confirmed against official docs. The
   upstream annotation/instructions items (was §3, targeted 1.9.0) are all
   closed in the pinned 1.10.0. The remaining blockers are purely
   operational: migrations (§2.1), a permanent prod origin, org
   prerequisites, and legal URLs.
