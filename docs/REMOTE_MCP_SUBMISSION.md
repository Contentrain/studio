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

## 0. Status at a glance (re-verified 2026-10-23: Studio `0.4.10`, MCP `3.11.2`)

Re-verified from code (Studio `main` f7ca93ac, whose MCP surface is identical
to the `v0.4.10` tag; `@contentrain/mcp` pinned exactly `3.11.2` in
`package.json` and the lockfile) plus read-only GETs of the public endpoints
on prod. No login and no POSTs, so nothing behind auth was re-run: those rows
keep their result, labelled 2026-07-27 @2.3.0.

| Area | State |
|------|-------|
| Prod answers `0.4.10`: `GET /api/health` → `version` `0.4.10`, `commit` ee497e45 (the `v0.4.10` tag) | ✅ 2026-10-23 |
| PRM (RFC 9728) at `/.well-known/oauth-protected-resource/api/mcp/remote` and the bare `/.well-known/oauth-protected-resource`: `resource` = `https://studio.contentrain.io/api/mcp/remote`, `authorization_servers` = [origin], all 6 scopes (media advertised), `bearer_methods_supported: [header]` | ✅ 200, `max-age=300`, 2026-10-23 |
| ASM (RFC 8414) at `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`: issuer = origin, authorize/token/register, `S256`, `token_endpoint_auth_methods: [none]`, `client_id_metadata_document_supported: true` (CIMD) | ✅ 200, `max-age=300`, 2026-10-23 |
| `resource` string and `issuer` unchanged since listing prep (§7) | ✅ |
| Bare request to `/api/mcp/remote` → 401 + `WWW-Authenticate` with `resource_metadata` + `scope="content:read content:write project:metadata"` | ✅ tested with **GET** 2026-10-23 (the handler authenticates before anything else, so POST gets the same) |
| `/.well-known/openai-apps-challenge` → 404 while `NUXT_OPENAI_APPS_CHALLENGE` is unset (correct until §6 step 1) | ✅ 2026-10-23 |
| Tool annotations @ MCP **3.11.2**: 27 tools, all with `title` + `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`, names ≤64, `openWorldHint: true` only on `media_ingest` | ✅ from code |
| Remote `tools/list` = **16** for a media-eligible project, **11** otherwise (see §4) | ✅ from code; not re-listed live |
| Unavailable tools are **not registered** (MCP's `skipTools`) | ✅ |
| Every remote tool is grantable by a scope (`mcp-tool-classes.ts` → `scopes.ts`) | ✅ from code |
| Read/write split — no catch-all `api_request` | ✅ |
| Server `instructions` name only registered tools: at MCP 3.11.12 this surface gets 456 chars without the `contentrain_apply` clause (§4.1 defect 5) | ✅ fixed upstream in 3.11.12 (ai#651), pinned 2026-10-23; from the published tarball, not re-read live |
| §3 post-bump check for 2.3.0 → 3.11.2 (tarball diff + one real staging content save) | ⏳ **not done** |
| DCR → 201, review account, prod-origin E2E (write chain, media, step-up, revocation) | ✅ 2026-07-27 @2.3.0; **not re-run at 3.11.2** |
| Legal URLs, public documentation | ✅ (unchanged; not re-fetched) |
| Live client passes (#2 Claude connector, #4 ChatGPT, #5 Codex, #7 refresh > 1h) | ⏳ need a human (§4) |
| **Claude Team/Enterprise org** | ❌ open |

What is left: one upstream fix (defect 5) that must land **before** the
OpenAI tool scan, because the scan snapshots the instructions; the §3
post-bump check; the human client passes; the org gate.

**One sequencing trap:** Railway auto-deploys `main` to *staging*; production
deploys only on a `v*` tag. Fixes merged to `main` are therefore not on the
origin being submitted until a release is cut. Cut the tag before submitting,
or reviewers meet the bugs the fixes already closed. `GET /api/health` names
the build that answers (`version`, `commit`): check it before any prod pass.

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
- **No domain-verification *challenge* for Anthropic.** The Connectors
  Directory explicitly requires no DNS/`.well-known` ownership proof — that
  mechanism belongs to the open MCP Registry and to OpenAI (§6), so do not
  chase it here. Note the distinction though: the Software Directory Policy
  still obliges developers to "verify that they own or control any API
  endpoint, domain, or user interface". It is an attestation, not a challenge
  — and it binds both directories.

## 3. Upstream `@contentrain/mcp` — pinned 3.11.12 (history below from 2.1.x–3.11.12)

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

The same check on 2.1.1 → 2.3.0 (which carries §4.1's defects 3 and 4, plus a
normalize fix for a `contentrain_apply` path that is `projectRoot`-gated and so
never reachable here): the GitHub provider diff is entirely additive — a new
`providers/shared/errors.ts` — while `applyPlan` and `createBranch` differ only
by their sourcemap name. `isNotFoundError` keeps its behaviour on a superset of
error shapes. Studio references none of the MCP error contract, and the
`applyPlan` self-heal keys on `input.base` rather than the error, so neither is
exposed to the new envelope.

- [x] `title` on every tool; `readOnlyHint`/`destructiveHint` correct;
      names ≤ 64 chars; `openWorldHint` present (`media_ingest` only).
- [x] `sessionFingerprint` wired in Studio (`mcp-cloud-server.ts` →
      `mcpTenantFingerprint`); `TOOL_REQUIREMENTS` drives the media scope→tool map.
- [x] **3.11.2 → 3.11.12 (2026-10-23), by tarball diff:** the only `dist/`
      deltas are the `version` string, `defaultInstructions(available)` (the
      `contentrain_apply` clause only where that tool is registered; with every
      tool available `DEFAULT_INSTRUCTIONS` is byte-identical) and the HTTP
      entries passing an optional `instructions` through. No tool, schema,
      annotation or provider change. Its `@contentrain/types` is 1.73.0, so
      Studio's `types` (1.73.0) and `query` (7.6.54) moved with it to keep one
      copy. The instructions change counts for the OpenAI resubmission rule
      below; it lands before the scan. The staging content save is not done.
- [ ] **2.3.0 → 3.11.2: not done yet.** Diff the published tarballs' `dist/`
      and do one real staging content save (the rule below). The surface grew
      from 24 to 27 tools (`contentrain_describe_format`,
      `contentrain_vocabulary_save`, `contentrain_vocabulary_delete`);
      `contentrain_doctor` is now `projectRoot`-gated.
- [ ] After any future MCP bump: diff the published tarballs' `dist/` and do a
      real staging content save before trusting the mocked suite. A bump that
      changes tool names/descriptions/schemas/annotations/**instructions**
      forces an OpenAI **version resubmission** — batch MCP upgrades around
      that cycle.

## 4. Manual test matrix (prod origin — staging is not sufficient for the attestation)

CIMD is the primary path; DCR is the fallback (Codex, and Claude when CIMD
selection fails).

**Last full pass: production origin, 2026-07-27, at MCP 2.3.0.** The whole
dance — review-login → DCR → authorize → consent → code → token (all 6 scopes +
refresh) → `initialize` → `tools/list` — then every tool, the full write chain
(`content_save`/`model_save` → `cr/*` → auto-merge → `contentrain` →
`context.json` regeneration → `cr/*` auto-deletion), real `media_ingest` (webp +
variants + blurhash), scope step-up and revocation. The demo repo was left in
its original state and the probe grants were deleted from Connected Apps.
**None of the authenticated rows has been re-run at 3.11.2** (2026-10-23 was
code + public GETs only); the ✅ marks below are that pass, labelled 2026-07-27 @2.3.0.

**Expected `tools/list` at 3.11.2: 16** for a media-eligible project, 11
without media. 27 tools exist; 11 are never registered here because they need
a local `projectRoot` (MCP's `skipTools`): `init`, `scaffold`, `doctor`,
`bulk`, `submit`, `merge`, `reconcile`, `branch_list`, `branch_delete`,
`scan`, `apply`. The 16 (all `contentrain_*`):

| Tool | read | destr. | idem. | openWorld | Scope |
|------|:---:|:---:|:---:|:---:|-------|
| `status` | ✓ | – | ✓ | – | `project:metadata` |
| `describe` | ✓ | – | ✓ | – | `project:metadata` |
| `describe_format` | ✓ | – | ✓ | – | `project:metadata` |
| `content_list` | ✓ | – | ✓ | – | `content:read` |
| `model_save` | – | – | ✓ | – | `content:write` |
| `model_delete` | – | ✓ | – | – | `content:write` |
| `vocabulary_save` | – | – | ✓ | – | `content:write` |
| `vocabulary_delete` | – | ✓ | – | – | `content:write` |
| `content_save` | – | – | ✓ | – | `content:write` |
| `content_delete` | – | ✓ | – | – | `content:write` |
| `validate` | – | – | ✓ | – | `content:write` (MCP marks it a write: `fix: true`) |
| `media_list` | ✓ | – | ✓ | – | `media:read` |
| `media_get` | ✓ | – | ✓ | – | `media:read` |
| `media_ingest` | – | – | – | **✓** | `media:write` |
| `media_update` | – | – | ✓ | – | `media:write` |
| `media_delete` | – | ✓ | – | – | `media:write` |

The 5 media tools appear only when the proxy attests media eligibility (plan +
`cdn_enabled` + media stack); prod advertises the `media:*` scopes, so the
review account must be media-eligible (§2) or the portal syncs 11.

One honest caveat: the 2.3.0 pass ran through a raw HTTP harness. The portal
asks you to confirm you exercised the tools *"via MCP Inspector or as a custom
connector in Claude"*. Functionally equivalent, but do one pass through a real
client before ticking that box.

| # | Client | Pass criteria | Prod |
|---|--------|---------------|------|
| 1 | MCP Inspector | Walk discovery → CIMD/register → consent → `tools/list`; exercise EVERY tool once, each returning a non-generic response | ✅ 2026-07-27 @2.3.0: 14/14 (raw harness); ⏳ **human** at 3.11.2: 16/16 in a real client |
| 2 | Claude custom connector | Connect card appears from the bare 401; consent shows the client host; tools run | ⏳ **human** |
| 3 | Claude Code | `claude mcp add --transport http contentrain <url>`; RFC 8252 loopback callback works | ✅ on staging 2026-07-14 |
| 4 | ChatGPT developer mode | CIMD/DCR registration + consent complete; tools listed | ⏳ **human** |
| 5 | Codex | `codex mcp login contentrain`; DCR path completes | ⏳ **human** |
| 6 | Scope step-up | 403 `insufficient_scope` → client re-prompts consent → retry succeeds | ✅ 2026-07-27 @2.3.0: 403 + `WWW-Authenticate: insufficient_scope` with `scope` + `resource_metadata`; reads keep working |
| 7 | Refresh rotation | Stay connected > 1h; silent refresh, no re-auth prompt | ⏳ **human** (needs the wait) |
| 8 | Revocation | Client's next call prompts a clean re-authorization | ✅ 2026-07-27 @2.3.0: 401 + `invalid_token`; **refresh token rejected too** (family revoked) |
| 9 | Write path | `cr/*` lands + auto-merge reconcile fires | ✅ 2026-07-27 @2.3.0 on GitHub; ⏳ one real pass at 3.11.2 (§3 post-bump rule) |
| 10 | Media | Tools appear in `tools/list` and return real assets | ✅ 2026-07-27 @2.3.0, all 5; ⏳ one real pass at 3.11.2 |

**Needs a human** (a real client account, a browser consent, or a wait):
#1 in a real client, #2 Claude custom connector, #4 ChatGPT developer mode,
#5 Codex, #7 refresh after > 1h, and the 3.11.2 passes of #9 and #10. Run them
after defect 5 is fixed and released, so the instructions the clients see are
the ones submitted.

### 4.1 Defects found while running the matrix

Four found in the 2.3.0 run, in review-risk order, **all four fixed** — two
here, two upstream in `Contentrain/ai` (2.3.0) — and a fifth found on the
3.11.2 re-verify, **open** upstream. They are the same class the 2.1.1 `dry_run` fix
belonged to: *a response that does not match what the surface actually does.*
Anthropic's criteria call this out twice — descriptions must match behaviour,
and errors must be actionable.

They are recorded rather than deleted because the shape recurs: anything that
narrows this surface (a capability gate, an async reconcile, a provider error)
can leave a response describing a world the caller is not in.

1. **Read-after-write race — `studio`, FIXED.** `reconcileMcpCloudAutoMerge`
   was fire-and-forget, so a write returned before its `cr/*` branch reached
   `contentrain`. An agent that created an entry and immediately listed it saw
   stale data; one that created and immediately deleted it got a hard failure
   (`content_delete` → `Invalid tree info`, `model_delete` → `Model not found`).
   Both succeeded once the merge landed. Reviewers exercise tools in sequence,
   so "create → verify" and "create → delete" are exactly the paths they walk.

   Awaiting the reconcile where it stood would have changed nothing: h3's
   `proxyRequest` writes the loopback response to the socket before it
   resolves, so the agent already held the result. Write `tools/call`s are
   therefore **buffered instead of streamed** — they answer with a short JSON
   or single-event SSE payload, never a long-lived stream, so nothing is lost.
   Reads still stream. The reconcile's *outcome* still cannot change the
   response: failures are swallowed, and one that outruns a 15s deadline is
   left to finish in the background, degrading to the old behaviour rather
   than holding the caller open.

   **Only step 1 of the merge is awaited.** Measured on prod at `v0.2.1`, a
   write cost ~18s against ~1-2s for a read, because the reconcile ran all
   ~13 sequential GitHub round trips before answering. Roughly 8 of those —
   `context.json` regeneration and the `contentrain → main` advance — are
   bookkeeping no MCP caller observes: agents read `contentrain`, and content
   reads come from the tree. That half now runs detached, mirroring the chat
   agent, which lands writes on `contentrain` per save and flushes the
   finalize once at turn end. Keep the split: collapsing it back restores the
   18s write and leaves ~1s of margin under the deadline, where a slow GitHub
   day silently reinstates the stale-read bug.
2. **Connecting a repo does not create the `contentrain` branch — `studio`,
   FIXED.** `POST /api/workspaces/:workspaceId/projects` never called
   `initProject`; the only caller is the chat agent, which never runs for a
   repo with nothing left to scaffold. Until someone inited through chat, every
   write failed on the missing base ref while reads, `validate` and `/health`
   (`healthScore: 100`) all looked perfect. Project creation now establishes the
   branch before the row exists, and `applyPlan` self-heals projects connected
   before that (`server/utils/ensure-content-branch.ts`). Diagnose the old state
   with `GET /repos/<owner>/<repo>/git/ref/heads/contentrain` → 404.
3. **Raw GitHub errors reached the MCP client — `ai`, FIXED in 2.3.0.** e.g.
   `Not Found - https://docs.github.com/rest/git/refs#get-a-reference` and
   `Invalid tree info - https://docs.github.com/rest/git/trees#create-a-tree`,
   carrying only a `stage` field — non-actionable, and a plausible rejection on
   its own. Provider rejections now map onto the same structured envelope the
   local git paths already produced: a `PROVIDER_*` code plus `agent_hint` and
   `developer_action`, vendor documentation URLs stripped and the detail length
   capped.
4. **`contentrain_validate` recommended an unavailable tool — `ai`, FIXED in
   2.3.0.** Its `next_steps` said "Run contentrain_submit to push changes", but
   `submit` is `localWorktree`-gated and absent from this surface. The hint is
   now gated on `isToolAvailable(...)`, so it is simply not emitted here.

5. **Server instructions name a tool this surface never registers — `ai`,
   FIXED in 3.11.12 (found 2026-10-23 at 3.11.2).** The default is now built
   from the session's registered tools, and the HTTP entry takes
   `instructions`; this surface gets 456 chars with no `contentrain_apply`.
   As found: `DEFAULT_INSTRUCTIONS` (507 chars)
   ends with *"preview contentrain_apply with dry_run:true first"*, but
   `contentrain_apply` is `projectRoot`-gated and never on `/api/mcp/remote`.
   Studio cannot override it: `startHttpMcpServerWith` calls
   `createServer({ provider, projectRoot })` with no `instructions`, so the
   default is always sent. It is defect 4's class (a hint for an unavailable
   tool), at `initialize`, where reviewers read it and where OpenAI's scan
   snapshots it. Fix upstream: make the default availability-aware, or let the
   HTTP entry take `instructions`. **It must land before the OpenAI scan**,
   or the fix later forces a version resubmission.

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
