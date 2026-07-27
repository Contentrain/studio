# Remote MCP — Directory Submission Runbook (internal)

Operator playbook for listing Studio's remote MCP endpoint
(`https://studio.contentrain.io/api/mcp/remote`) in the **Claude Connectors
Directory** and the **OpenAI Plugin directory** (covers ChatGPT + Codex).
User-facing docs live in [REMOTE_MCP.md](./REMOTE_MCP.md).

> **Scope: this repo owns ONE of two Claude listings.** Anthropic runs two
> separate, complementary directories with different gates and different
> owning repos. This runbook covers only the connector.
>
> | | Plugin Directory | **Connectors Directory** |
> |---|---|---|
> | Owning repo | `Contentrain/ai` (public, MIT) | **`Contentrain/studio`** (here) |
> | Artifact | plugin = skills + local stdio MCP | `/api/mcp/remote` (OAuth 2.1) |
> | End user needs | a git repo — **no account** | a Studio project (**account required**) |
> | Submit gate | public repo + `claude plugin validate`; **Console form has no plan gate** | **Team or Enterprise org — no Console path** |
>
> The two tracks are independently shippable and run in parallel. Neither
> blocks the other. Listing copy for **both** comes from one source:
> `AI_DIRECTORY_POSITIONING.md` at the root of `Contentrain/ai` — do not
> draft listing copy here, and never in `scratchpad/` (earlier drafts were
> lost that way).

> Requirements re-verified against official docs **2026-07-27**
> (claude.com/docs/connectors, claude.com/docs/plugins,
> developers.openai.com/apps-sdk). Live discovery/auth surface smoke-tested
> against the **production** origin the same day; results are inline.

> **The origin is contractual.** OpenAI treats a change of scheme/host/port
> as a brand-new app (domain verification + `callback_id` are host-bound);
> Claude's URL slug is **permanent once published** and the PRM `resource`
> string must match the entered URL exactly, incl. path. Never change the
> PRM `resource` string or the AS `issuer` after listing.

## 0. Status at a glance (verified against prod 2026-07-27)

| Area | State |
|------|-------|
| Prod origin live (`studio.contentrain.io`), v0.2.0 tagged | ✅ |
| PRM (RFC 9728) — `resource` = endpoint, `authorization_servers[0]` = origin | ✅ 200 on prod |
| ASM (RFC 8414) — issuer + authorize/token/register, `S256`, CIMD advertised | ✅ 200 on prod |
| Bare `POST /api/mcp/remote` → 401 + `WWW-Authenticate` w/ `resource_metadata` + `scope` | ✅ on prod |
| **`POST /oauth/register` (DCR) → 201** — proves `016`/`017`/`018` applied to the prod DB | ✅ **the old §2.1 blocker is closed** |
| Tool annotations @ MCP **2.1.1** — 24 tools, all `title` + `readOnlyHint`/`destructiveHint`, names ≤64, `openWorldHint` only on `media_ingest` | ✅ zero gaps |
| Unavailable tools are **not registered** (MCP's `skipTools`) — no listed-but-always-erroring tool | ✅ |
| Read/write split — no catch-all `api_request` | ✅ |
| Legal URLs live on contentrain.io (`/legal/privacy-policy`, `/legal/terms`, `/legal/cookie-policy`, `/legal/mcp-connector-privacy`) | ✅ |
| Public documentation (`docs.contentrain.io/developer/mcp-connector`, `contentrain.io/docs/mcp-connector`) | ✅ |
| **Review account** — provisioned on prod against a populated, media-eligible demo workspace | ✅ |
| **Prod-origin E2E** — all 14 tools, write chain, media, scope step-up, revocation | ✅ (§4) |
| Refresh rotation (needs a >1h connection) | ⏳ pending |
| **Claude Team/Enterprise org** | ❌ **open — the only remaining gate** |

Everything technical is verified against production. What is left is operational —
plus the four defects in §4.1, two of which are ours.

## 1. Organizational prerequisites (weeks of lead time — start first)

- [ ] **Claude**: **Team or Enterprise** org. Submission portal is
      `claude.ai/admin-settings/directory/submissions/new`. By default only
      org **Owners** submit; on Enterprise an Owner can delegate a custom
      role with the **Directory management** permission (Team plans have no
      custom roles → stays with Owners). **There is no Console path for
      connectors** — unlike plugins, which individual authors can submit via
      `platform.claude.com/plugins/submit`. Escalations: `mcp-review@anthropic.com`.
- [ ] **OpenAI**: organization (or individual) **verification** under the
      publishing name in the Platform Dashboard, the **`api.apps.write`**
      permission, and a **global-residency** project — **EU-residency
      projects cannot submit** plugins for review.
- [x] Public **docs URL**, **privacy policy URL**, **support contact** — all
      live (see §0). On Claude a missing/incomplete privacy policy is an
      **immediate rejection**; ours is a dedicated connector addendum.

## 2. Technical prerequisites (this repo)

- [x] Discovery chain answers on the **production** origin — see §0.
      Anthropic egress is `160.79.104.0/21`.
- [x] Production runs the managed pair with
      `NUXT_PUBLIC_SITE_URL=https://studio.contentrain.io`.
- [x] **Migrations applied to prod.** DCR returning 201 is the proof. Keep
      the Railway **Pre-Deploy Command** (`node scripts/migrate-postgres.mjs`)
      in place on both services so schema always precedes the image.
- [x] **Review account** — `/auth/review-login` is a password login with no
      OAuth/MFA/email step (OpenAI + Claude hard requirement). Live on prod
      via `NUXT_REVIEW_ACCOUNT_EMAIL` + `NUXT_REVIEW_ACCOUNT_PASSWORD` (≥16
      chars, boot-validated — a shorter value fails startup).

      One non-obvious thing: **do not create the user by hand.** The route's
      `upsertEmailUser` insert fires the `handle_new_user()` trigger, which
      provisions the profile and a `primary` workspace, and no password is
      stored in the DB — the route compares against the env value only. So the
      env comes *first*, and the first login *is* the account creation. The
      workspace it creates starts on the free tier; on the managed profile,
      entitlement resolution is not driven by `workspaces.plan` alone, so
      confirm the review workspace actually resolves to a paid tier before
      handing credentials to a reviewer.

      **Make it media-eligible** — the portal syncs tools from the connected
      server, so a non-eligible review account means the 5 media tools are
      never listed and never reviewed. Rotate/unset after each cycle.

      Operator specifics for Contentrain's own review account (identities,
      entitlement steps, teardown) are deliberately **not** in this public
      AGPL repo — keep them in the internal operator notes.
- **No domain verification is needed for Anthropic.** Their directory
  explicitly requires no DNS/`.well-known` ownership proof — that applies
  only to the open MCP Registry and to OpenAI (§6). Do not chase it here.

## 3. Upstream `@contentrain/mcp` — pinned 2.1.1

**The 2.1.0 → 2.1.1 bump is submission-relevant, not housekeeping.** 2.1.0's
`DEFAULT_INSTRUCTIONS` told every client to *"Preview writes with
`dry_run:true` … then re-run with `dry_run:false`"*, but `dry_run` exists only
on `contentrain_apply`; on every other write tool the unknown key is stripped
by the schema, so an agent following the server's own instructions performed a
**real write while believing it had previewed**. Reviewers see this string at
`initialize` and OpenAI snapshots it into the versioned contract; Anthropic's
criteria require descriptions to match actual behavior. 2.1.1 replaces it with
the real safety model (isolated `cr/*` branches, `content_save` validates
before committing, destructive tools need `confirm:true`, `dry_run` belongs to
`contentrain_apply`). 494 → 507 chars, still under the 512 client-UI budget.

Verified by tarball diff rather than trusting the changelog: the only deltas
between 2.1.0 and 2.1.1 are the `version` string, that instructions string (in
both its `const` and inline-default positions), and the sourcemap filename.
**No git-internals change, no tool-behavior change.**

- [x] `title` on every tool; `readOnlyHint`/`destructiveHint` correct;
      names ≤ 64 chars; `openWorldHint` present (`media_ingest` only).
- [x] `sessionFingerprint` wired in Studio (`mcp-cloud-server.ts` →
      `mcpTenantFingerprint`); `TOOL_REQUIREMENTS` drives the media scope→tool map.
- [ ] After any future MCP bump: diff the published tarballs' `dist/` and do a
      real staging content save before trusting the mocked suite. A bump that
      changes tool names/descriptions/schemas/annotations/**instructions**
      forces an OpenAI **version resubmission** — batch MCP upgrades around
      that cycle.

## 4. Manual test matrix (prod origin — staging is not sufficient for the attestation)

CIMD is the primary path; DCR is the fallback (Codex, and Claude when CIMD
selection fails).

**Verified against the production origin 2026-07-27.** The whole dance —
review-login → DCR → authorize → consent → code → token (all 6 scopes +
refresh) → `initialize` → `tools/list` — then every one of the 14 tools, the
full write chain (`content_save`/`model_save` → `cr/*` → auto-merge →
`contentrain` → `context.json` regeneration → `cr/*` auto-deletion), real
`media_ingest` (webp + variants + blurhash), scope step-up and revocation.
The demo repo was left in its original state and the probe grants were
deleted from Connected Apps.

`tools/list` returns **14**, not 24: the 10 `projectRoot`/`localWorktree`
tools are never registered on this provider (MCP's `skipTools`). That is
correct — expect 14 in the portal's tool sync.

One honest caveat: the pass above ran through a raw HTTP harness. The portal
asks you to confirm you exercised the tools *"via MCP Inspector or as a custom
connector in Claude"*. Functionally equivalent, but do one pass through a real
client before ticking that box.

| # | Client | Pass criteria | Prod |
|---|--------|---------------|------|
| 1 | MCP Inspector | Walk discovery → CIMD/register → consent → `tools/list`; exercise EVERY tool once, each returning a non-generic response | ✅ 14/14 (raw harness — see caveat above) |
| 2 | Claude custom connector | Connect card appears from the bare 401; consent shows the client host; tools run | ⏳ do one pass for the attestation |
| 3 | Claude Code | `claude mcp add --transport http contentrain <url>`; RFC 8252 loopback callback works | ✅ on staging 2026-07-14 |
| 4 | ChatGPT developer mode | CIMD/DCR registration + consent complete; tools listed | ○ |
| 5 | Codex | `codex mcp login contentrain`; DCR path completes | ○ |
| 6 | Scope step-up | 403 `insufficient_scope` → client re-prompts consent → retry succeeds | ✅ 403 + `WWW-Authenticate: insufficient_scope` with `scope` + `resource_metadata`; reads keep working |
| 7 | Refresh rotation | Stay connected > 1h; silent refresh, no re-auth prompt | ⏳ needs the wait |
| 8 | Revocation | Client's next call prompts a clean re-authorization | ✅ 401 + `invalid_token`; **refresh token rejected too** (family revoked) |
| 9 | Write path | `cr/*` lands + auto-merge reconcile fires | ✅ merge + `context.json` regeneration + `cr/*` auto-deletion all confirmed on GitHub |
| 10 | Media | Tools appear in `tools/list` and return real assets | ✅ all 5; `media_ingest` produced webp + og/card variants + blurhash |

### 4.1 Defects found while running the matrix

Four, in review-risk order. **Two are ours.** All four are the same class the
2.1.1 `dry_run` fix belonged to: *a response that does not match what the
surface actually does.* Anthropic's criteria call this out twice — descriptions
must match behaviour, and errors must be actionable.

1. **Read-after-write race — `studio`, OPEN.** `reconcileMcpCloudAutoMerge` is
   fire-and-forget, so a write returns before its `cr/*` branch reaches
   `contentrain`. An agent that creates an entry and immediately lists it sees
   stale data; one that creates and immediately deletes gets a hard failure
   (`content_delete` → `Invalid tree info`, `model_delete` → `Model not found`).
   Both succeeded once the merge landed. Reviewers exercise tools in sequence,
   so "create → verify" and "create → delete" are exactly the paths they walk.

   **The obvious fix does not work.** Awaiting the reconcile where it is called
   changes nothing for the caller: h3's `proxyRequest` writes the loopback
   response to the socket before it resolves, so the agent already holds the
   result by the time that line runs — the existing comment is accurate. Making
   the write durable before responding means the proxy can no longer stream a
   write `tools/call`: it has to buffer the loopback response, reconcile, then
   send. That touches a path which also carries header stripping, quota and
   rate limiting, so it wants its own change with its own tests.
2. **Connecting a repo does not create the `contentrain` branch — `studio`,
   FIXED.** `POST /api/workspaces/:workspaceId/projects` never called
   `initProject`; the only caller is the chat agent, which never runs for a
   repo with nothing left to scaffold. Until someone inited through chat, every
   write failed on the missing base ref while reads, `validate` and `/health`
   (`healthScore: 100`) all looked perfect. Project creation now establishes the
   branch before the row exists, and `applyPlan` self-heals projects connected
   before that (`server/utils/ensure-content-branch.ts`). Diagnose the old state
   with `GET /repos/<owner>/<repo>/git/ref/heads/contentrain` → 404.
3. **Raw GitHub errors reach the MCP client — `ai`.** e.g.
   `Not Found - https://docs.github.com/rest/git/refs#get-a-reference` and
   `Invalid tree info - https://docs.github.com/rest/git/trees#create-a-tree`,
   carrying only a `stage` field. Non-actionable; a plausible rejection on its
   own.
4. **`contentrain_validate` recommends an unavailable tool — `ai`.** Its
   `next_steps` says "Run contentrain_submit to push changes", but `submit` is
   `localWorktree`-gated and absent from this surface.

## 5. Claude submission (claude.ai → Admin settings → Directory)

1. Run the [pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria).
   Key rejection rules: every tool needs `title` +
   `readOnlyHint`/`destructiveHint`; **read and write must be separate tools**
   (a catch-all `api_request` with a `method` param is auto-rejected —
   Studio's surface is already split); first-party APIs only; no money
   transfer; no AI image/video/audio generation; privacy policy mandatory;
   test credentials must be a **fully populated** account.
2. Portal steps (`…/directory/submissions/new`): Introduction, Connection
   (production URL, streamable HTTP, "same URL for every user"), Tools sync,
   Listing (**name ≤100, tagline ≤55, description ≤2000, 1–5 categories**,
   docs + privacy URLs, support contact, icon, **permanent slug**), Use cases,
   Company, Authentication (**OAuth — CIMD primary, DCR fallback**; both
   out-of-the-box), Data handling (first-party API), Test & launch (review
   creds + step-by-step access + confirm every tool exercised), Compliance
   (seven acknowledgments, all required), Review.
3. **Copy comes from `AI_DIRECTORY_POSITIONING.md` in `Contentrain/ai`.**
   Locked there: name `Contentrain`, permanent slug `contentrain`, connector
   tagline `Edit your Git-backed product content, safely` (44), categories
   **Developer Tools** (primary) + **CMS & Web** (secondary), and the full
   ≤2000-char description. Never position the connector as a "headless CMS".
4. Listings start as **community connector** (automated scan); Anthropic
   **auto-escalates** standout ones to **verified** (functional per-tool
   testing) — no action needed. Review times vary with queue; no SLA. Track in
   `claude.ai/admin-settings/directory/submissions`.

## 6. OpenAI submission (Plugin directory — one submission covers ChatGPT + Codex)

> Since **2026-07-09** the "app directory" is the **Plugin directory**; a
> plugin bundles skills + apps + templates and surfaces across ChatGPT
> web/desktop, ChatGPT Work, and Codex. Submission page:
> `developers.openai.com/apps-sdk/deploy/submission`.

1. **Domain verification** — required *here*, unlike Anthropic. The verifier
   fetches the challenge at the **apex root**
   (`https://studio.contentrain.io/.well-known/openai-apps-challenge`) and
   strips any subpath, so the subpath MCP endpoint is fine. Set
   `NUXT_OPENAI_APPS_CHALLENGE` to the portal token, confirm the route serves
   it (404 until set — correct), unset after verification.
2. Create the plugin draft → add MCP server details → **Scan Tools**. This
   **snapshots** tool names/titles/descriptions/schemas/security schemes/
   `_meta`/annotations/UI-resource-CSP/**server instructions** into a
   versioned contract. Changing any of these later = new draft version →
   re-scan → resubmit. **Only one version published and one in review at a
   time** (withdraw via Cancel Review). Server-only fixes that preserve the
   contract don't need resubmission.
3. Auth: **CIMD preferred** (our AS advertises it); DCR supported as fallback.
   Per-app redirect URI is `https://chatgpt.com/connector/oauth/{callback_id}`
   (generated per app instance) — self-serve via CIMD/DCR, nothing to
   pre-register.
4. Provide: app name/logo/description, company + privacy URLs, review
   credentials (§2 — **no MFA/SMS/email**, must work off-LAN), test prompts
   with expected responses (reviewers verify on **web AND mobile**), and
   **per-annotation justification** (`openWorldHint`/`destructiveHint`/
   `readOnlyHint`).
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
- Tool-surface changes (names/descriptions/schemas/**instructions** via an MCP
  bump) require an OpenAI **version resubmission** — batch them; Claude
  re-syncs tools automatically but the same annotation rules re-apply.
- Migrations run before every deploy (Railway Pre-Deploy Command) — never ship
  an image ahead of its schema.
- If the plugin listing (`Contentrain/ai`) bundles this connector, having it
  in the Connectors Directory reduces the warnings shown to plugin users and
  improves verification odds — a reason to finish this track, never a reason
  to block the other one.
