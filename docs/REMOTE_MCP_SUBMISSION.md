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
> | Submit gate | public repo + `claude plugin validate`; **Console form has no plan gate** | **any paid Claude plan** at `claude.ai/directory/manage` (was Team/Enterprise only until the 2026-11-02 re-check) |
>
> The two tracks are independently shippable and run in parallel. Neither
> blocks the other. Listing copy for **both** comes from one source:
> `AI_DIRECTORY_POSITIONING.md` at the root of `Contentrain/ai` — do not
> draft listing copy here, and never in `scratchpad/` (earlier drafts were
> lost that way).

> Requirements re-verified against official docs **2026-11-02**
> (claude.com/docs/connectors/building/{authentication,submission,review-criteria},
> developers.openai.com/plugins/deploy/{submission,app-review},
> developers.openai.com/plugins/plugin-guidelines). Live discovery/auth
> surface re-checked against the **production** origin 2026-11-02 (public
> read-only GETs) and last fully exercised 2026-07-27; results are inline.

> **The origin is contractual.** OpenAI treats a change of scheme/host/port
> as a brand-new app (domain verification + `callback_id` are host-bound);
> Claude's URL slug is **permanent once published** and the PRM `resource`
> string must match the entered URL exactly, incl. path. Never change the
> PRM `resource` string or the AS `issuer` after listing.

## 0. Status at a glance (re-verified 2026-11-02: Studio `0.4.16`, MCP `3.11.20`; MCP rows re-read at `3.11.23` for v0.4.17; pin `3.11.24` from v0.4.19)

Re-verified from code (Studio `main` 0a33468 = the `v0.4.16` tag,
`@contentrain/mcp` pinned exactly `3.11.20`; annotations and instructions
read from the installed package; v0.4.17 pins `3.11.23`, and the MCP rows
below are re-read from that package; v0.4.19 pins `3.11.24`, which leaves them
unchanged) plus read-only GETs of the public endpoints
on prod, which answers that same commit. No login and no POSTs, so the rows
behind auth keep 2026-07-27 @2.3.0. The per-gap evidence is in §8.

| Area | State |
|------|-------|
| Prod answers `0.4.16`: `GET /api/health` → `version` `0.4.16`, `commit` 0a33468 (the `v0.4.16` tag) | ✅ 2026-11-02 |
| PRM (RFC 9728) at `/.well-known/oauth-protected-resource/api/mcp/remote` and the bare `/.well-known/oauth-protected-resource`: `resource` = `https://studio.contentrain.io/api/mcp/remote`, `authorization_servers` = [origin], all 6 scopes (media advertised), `bearer_methods_supported: [header]` | ✅ 200, `max-age=300`, 2026-11-02 |
| ASM (RFC 8414) at `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`: issuer = origin, authorize/token/register, `S256`, `token_endpoint_auth_methods: [none]`, `client_id_metadata_document_supported: true` (CIMD) | ✅ 200, `max-age=300`, 2026-11-02 |
| `resource` string and `issuer` unchanged since listing prep (§7) | ✅ |
| Bare request to `/api/mcp/remote` → 401 + `WWW-Authenticate` with `resource_metadata` + `scope="content:read content:write project:metadata"` | ✅ tested with **GET** 2026-11-02 (the handler authenticates before anything else, so POST gets the same) |
| `/.well-known/openai-apps-challenge` → 404 while `NUXT_OPENAI_APPS_CHALLENGE` is unset (correct until §6 step 1) | ✅ 2026-11-02 |
| Tool annotations @ MCP **3.11.24** (re-read 2026-11-03): every tool the reviewer sees (16 on a media-enabled project, 11 otherwise) has `title` + `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`, names ≤64, `openWorldHint: true` only on `media_ingest` | ✅ from code |
| `contentrain_model_save` and `contentrain_content_save` → `destructiveHint: true` (each replaces what it is sent: a whole definition, a singleton, an existing collection entry; OpenAI counts overwriting as destructive); `contentrain_content_save` → `idempotentHint: false` (a collection save without an id adds a new entry every call) | ✅ MCP 3.11.23; production serves it from v0.4.17, so cut that tag **before the OpenAI scan** |
| Remote `tools/list` = **16** for a media-eligible project, **11** otherwise (see §4) | ✅ from code @3.11.24; not re-listed live |
| OAuth callbacks: `https://claude.ai/api/mcp/auth_callback` and ChatGPT's per-app URL arrive through CIMD/DCR; loopback `http://localhost/callback` / `http://127.0.0.1/callback` match on **any port** | ✅ from code + tests (§8 gap 3) |
| Token endpoint: form-urlencoded, rotation in the same response, `invalid_grant` for a dead refresh token | ✅ from code + contract test (§8 gap 5) |
| Error copy on this surface names no plan and promotes no upgrade (OpenAI plugin guideline) | ✅ 2026-11-02 (§8) |
| Unavailable tools are **not registered** (MCP's `skipTools`) | ✅ |
| Every remote tool is grantable by a scope (`mcp-tool-classes.ts` → `scopes.ts`) | ✅ from code |
| Read/write split — no catch-all `api_request` | ✅ |
| Server `instructions` name only registered tools: at MCP 3.11.12 this surface gets 456 chars without the `contentrain_apply` clause (§4.1 defect 5) | ✅ fixed upstream in 3.11.12 (ai#651); re-read at 3.11.20 2026-11-02: still 456 chars, no `contentrain_apply`; `DEFAULT_INSTRUCTIONS` unchanged in the 3.11.20 → 3.11.23 diff; not re-read live |
| §3 post-bump check for 2.3.0 → 3.11.2 (tarball diff + one real staging content save) | ⏳ **not done** |
| §3 post-bump check for 3.11.12 → 3.11.20 (tarball diff + one real staging content save) | ⏳ **not done** |
| §3 post-bump check for 3.11.20 → 3.11.23 | ✅ tarball diff 2026-11-02; ⏳ staging content save **not done** |
| DCR → 201, review account, prod-origin E2E (write chain, media, step-up, revocation) | ✅ 2026-07-27 @2.3.0; **not re-run at 3.11.2** |
| Legal URLs, public documentation | ✅ (unchanged; not re-fetched) |
| Live client passes (#2 Claude connector, #4 ChatGPT, #5 Codex, #7 refresh > 1h) | ⏳ need a human (§4) |
| Claude submit gate: any paid plan can submit (no Team/Enterprise org needed) | ✅ 2026-11-02, from claude.com/docs/connectors/building/submission |
| Review account populated + media-eligible on prod (§2) | ⏳ founder |
| Support URL `https://contentrain.io/support` (on 2026-11-02 it still 301s to `/`) | ⏳ being built on iterum; check it answers 200 before submitting |

What is left: the §3 post-bump checks; the human client passes; the review
account (§2); the founder/account items in §1; the support page; cutting
v0.4.17 so production serves MCP 3.11.23; pasting §9.

**One sequencing trap:** Railway auto-deploys `main` to *staging*; production
deploys only on a `v*` tag. Fixes merged to `main` are therefore not on the
origin being submitted until a release is cut. Cut the tag before submitting,
or reviewers meet the bugs the fixes already closed. `GET /api/health` names
the build that answers (`version`, `commit`): check it before any prod pass.

## 1. Organizational prerequisites (weeks of lead time — start first)

- [ ] **Claude**: any **paid** Claude plan can submit (re-checked
      2026-11-02; the Team/Enterprise-only gate is gone). Portal:
      `claude.ai/directory/manage` → **Submit new** → **MCP connector**.
      Escalations: `mcp-review@anthropic.com`.
- [ ] **OpenAI**: organization (or individual) **verification** under the
      publishing name in the Platform Dashboard, and the org **Owner** role
      or **Apps Management: Write**. Data residency: the 2026-07-27 check
      found that **EU-residency projects cannot submit**; the 2026-11-02
      submission page does not mention residency, so that line is **not
      re-verified** — use a global-residency project to be safe.
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

      **Hard requirement: the review project must be media-enabled**
      (Starter or above through billing, `cdn_enabled` on, the review user
      as workspace owner), so the reviewer sees **16 tools, not 11**. The
      portal syncs tools from the connected server; a project without media
      means the 5 media tools are never listed and never reviewed. Do not
      hand out credentials until `tools/list` returns 16. Rotate/unset after
      each cycle.

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

## 3. Upstream `@contentrain/mcp` — pinned 3.11.24 (history below from 2.1.x–3.11.24)

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
- [ ] **3.11.12 → 3.11.20: not done yet.** Re-read 2026-11-02 from the
      installed 3.11.20 package: the 16 remote tools' annotations are
      unchanged (§4 table) and this surface's instructions are still 456
      chars with no `contentrain_apply` clause. The tarball diff and the
      staging content save are not done.
- [x] **3.11.20 → 3.11.23 (2026-11-02), by tarball diff:** on this surface
      the deltas are two annotations (`model_save` and `content_save`
      `destructiveHint: true`; `content_save` `idempotentHint: false`), the
      `contentrain_validate` description and `fix` text (`fix` only: backfilled
      meta is `published`, and a fix that changes what is delivered stays on
      its branch with `visibility_changes`; `fix` is not available here), and
      `initialize` now sends `title`, `websiteUrl` and `icons`
      (`SERVER_IDENTITY`, pointing at ai.contentrain.io). `DEFAULT_INSTRUCTIONS`,
      the GitHub provider and the `core/ops` plan helpers are unchanged;
      `core/validator` changes only under `fix`. Its `@contentrain/types` is
      1.79.2, so Studio's `types` moved to 1.79.2 and `query` to 7.6.63 (which
      pins the same). The annotation and description changes count for the
      OpenAI resubmission rule below; they land before the scan. The staging
      content save is not done.
- [x] **3.11.23 → 3.11.24 (2026-11-03), by tarball diff:** on this surface
      `contentrain_content_save` names `contentrain_bulk` only where that tool
      is registered (`publish_at` description, `scheduling_note`,
      `next_steps`), and the validator's publish-state drift notice says to set
      the status back to published. Annotations, tool names and
      `DEFAULT_INSTRUCTIONS` are unchanged; `@contentrain/types` stays 1.79.2.
      The `publish_at` description change counts for the OpenAI resubmission
      rule below.
- [ ] **2.3.0 → 3.11.2: not done yet.** Diff the published tarballs' `dist/`
      and do one real staging content save (the rule below). The MCP registry
      gained three tools (`contentrain_describe_format`,
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

**Expected `tools/list` at 3.11.24: 16** for a media-eligible project, 11
without media — that is what a reviewer sees. Eleven more MCP tools are never
registered here because they need a local `projectRoot` (MCP's `skipTools`): `init`, `scaffold`, `doctor`,
`bulk`, `submit`, `merge`, `reconcile`, `branch_list`, `branch_delete`,
`scan`, `apply`. The 16 (all `contentrain_*`):

| Tool | read | destr. | idem. | openWorld | Scope |
|------|:---:|:---:|:---:|:---:|-------|
| `status` | ✓ | – | ✓ | – | `project:metadata` |
| `describe` | ✓ | – | ✓ | – | `project:metadata` |
| `describe_format` | ✓ | – | ✓ | – | `project:metadata` |
| `content_list` | ✓ | – | ✓ | – | `content:read` |
| `model_save` | – | ✓ | ✓ | – | `content:write` |
| `model_delete` | – | ✓ | – | – | `content:write` |
| `vocabulary_save` | – | – | ✓ | – | `content:write` |
| `vocabulary_delete` | – | ✓ | – | – | `content:write` |
| `content_save` | – | ✓ | – | – | `content:write` |
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

## 5. Claude submission (`claude.ai/directory/manage`)

1. Run the [pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria).
   Key rejection rules: every tool needs `title` +
   `readOnlyHint`/`destructiveHint`; **read and write must be separate tools**
   (a catch-all `api_request` with a `method` param is auto-rejected —
   Studio's surface is already split); first-party APIs only; no money
   transfer; no AI image/video/audio generation; privacy policy mandatory;
   test credentials must be a **fully populated** account.
2. Portal steps (**Submit new → MCP connector**, 10 steps as of
   2026-11-02): Connection (production URL, streamable HTTP, "same URL for
   every user"), Tools (synced from the server), Listing (**name ≤100,
   one-liner ≤200, description ≤2000, 1–5 categories**, docs + privacy URLs,
   support contact, icon, **permanent slug**), Use cases, Company,
   Authentication (**OAuth — CIMD primary, DCR fallback**; both
   out-of-the-box), Data handling (first-party API), Test & launch (review
   creds + step-by-step access + confirm every tool exercised), Compliance
   (seven acknowledgments, all required), Review. The paste-ready answers
   are in §9.
   Auth contract the docs state, all met (§8): callback
   `https://claude.ai/api/mcp/auth_callback` plus `http://localhost/callback`
   and `http://127.0.0.1/callback` on any port; CIMD is used only when the AS
   advertises `client_id_metadata_document_supported: true` **and** `none` in
   `token_endpoint_auth_methods_supported`; `/token` takes form-urlencoded,
   rotates the refresh token in the same response and answers `invalid_grant`
   for a dead one; discovery/registration/token answer within 10 s, refresh
   within 30 s.
3. **Copy comes from `AI_DIRECTORY_POSITIONING.md` in `Contentrain/ai`.**
   Locked there: name `Contentrain`, permanent slug `contentrain`, connector
   tagline `Edit your Git-backed product content, safely` (44), categories
   **Developer Tools** (primary) + **CMS & Web** (secondary), and the full
   ≤2000-char description. Never position the connector as a "headless CMS".
4. Listings start as **community connector** (automated scan); Anthropic
   **auto-escalates** standout ones to **verified** (functional per-tool
   testing) — no action needed. Review times vary with queue; no SLA. Track in
   `claude.ai/directory/manage`.

## 6. OpenAI submission (Plugin directory — one submission covers ChatGPT + Codex)

> Since **2026-07-09** the "app directory" is the **Plugin directory**; a
> plugin bundles skills + apps + templates and surfaces across ChatGPT
> web/desktop, ChatGPT Work, and Codex. Submission page (re-checked
> 2026-11-02): `developers.openai.com/plugins/deploy/submission`.

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
4. The package is a ZIP with the MCP server included: root `plugin.json`
   (presentation under `extensions.com.openai.interface`) and `mcp.json`
   with **one** server, `type: "streamable-http"`, the production URL, and
   `extensions["com.openai"].auth` = `oauth` with `client.mode` `cimd`
   (`dcr` as the fallback). **No `clientId` and no client secret** in a
   `cimd`/`dcr` client object. Who builds and owns this ZIP is an open
   question (§9).
5. Provide (paste-ready text in §9): displayName **≤30**, shortDescription
   **≤30**, description **≤4000**, up to **3** starter prompts **≤128 chars**
   with no @mentions; exactly **5 positive test cases** (scenario, prompt,
   expected tools, expected result) and **3 negative** (prompt, reason,
   expected refusal or clarification); a demo video URL; release notes;
   website, support, privacy and terms URLs (all HTTPS, all required); a
   square icon ≥48 px and ≤5 MiB; review credentials (§2 — **no MFA, no
   email/SMS codes, no magic links, no private network**, populated with
   sample data); and **per-annotation justification**. The name must not
   contain "MCP" or "Plugin". The plugin must not display subscription
   plans, start a subscription, or promote upgrades — this surface's error
   copy follows that since 2026-11-02 (§8). OpenAI rescans daily; one review
   at a time.
6. After approval, publish from the portal.

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

## 8. Gap check against `main` (2026-11-02, Studio 0a33468, MCP 3.11.20)

Each requirement from the 2026-11-02 docs, checked against code. "Met" means
code + a test, not a live run; live passes are §4.

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Runbook states the current Claude gate | **Fixed here** | §1, §5: any paid plan, `claude.ai/directory/manage` |
| 2 | Real client passes at the pinned MCP | **Missing — needs a human** | §4 #1, #2, #4, #5, #7 and the 3.11.x passes of #9/#10; §3 tarball diff + staging save for 3.11.12 → 3.11.20 not done; 3.11.20 → 3.11.23 tarball diff done, staging save not done. Instructions at 3.11.20: 456 chars, no `contentrain_apply`, unchanged at 3.11.23 |
| 3 | Callbacks: `claude.ai/api/mcp/auth_callback`, ChatGPT per-app URL, loopback on any port | **Met** | `server/utils/oauth-server/redirects.ts:34` `matchRedirectUri` (exact match; loopback ignores the port, keeps scheme/host/path; `localhost` ≠ `127.0.0.1`); `tests/unit/oauth-redirects.test.ts:16`, `:22`, `:28`, `:34`. Hosted callbacks arrive through the client's CIMD document or DCR, so nothing is pre-registered |
| 4 | CIMD chosen: `client_id_metadata_document_supported: true` + `none` auth method | **Met** | `server/utils/oauth-server/metadata.ts:46-48` (plus `S256`, `offline_access`); `tests/unit/oauth-metadata.test.ts:28`, `:33`, `:37` |
| 5 | `/token`: form-urlencoded, rotation in the same response, `invalid_grant` for a dead refresh token | **Met** | `server/routes/oauth/token.post.ts:52` (`readBody` parses form and JSON), `:115` rotation; `server/utils/oauth-server/store.ts:23` 10 s grace, `:332` reuse outside grace revokes the family → `invalid_grant`; `tests/contract/oauth-server.contract.test.ts:129`. The 10 s/30 s timeouts: the path is DB-only with no outbound call, but no latency was measured |
| 6 | Bare request → 401 with `resource_metadata` | **Met** | `server/api/mcp/remote/[...slug].ts:48-51` authenticates first; `server/utils/oauth-server/challenge.ts:17` |
| 7 | Every tool has a `title` and explicit boolean hints | **Met** | every tool the reviewer sees (16 on a media-enabled project, 11 otherwise) at 3.11.23, read from the published package; §4 table and §9 justifications. `model_save` and `content_save` are `destructiveHint: true` from 3.11.23 (§0) |
| 8 | Consent shows who is asking | **Met** | `app/pages/oauth/consent.vue` shows `client.displayHost` and the loopback-only warning |
| 9 | Review login with no MFA/email/magic link | **Met (route)** / **missing (account)** | `server/api/auth/review-login.post.ts`, `app/pages/auth/review-login.vue`; env-gated, 404 when unset. The populated, media-eligible account is a founder item (§2, spec below) |
| 10 | OpenAI domain challenge | **Met** | `server/routes/.well-known/openai-apps-challenge.get.ts` serves `NUXT_OPENAI_APPS_CHALLENGE` as `text/plain`, 404 when unset |
| 11 | No subscription plans or upgrade promotion in the plugin (OpenAI) | **Fixed here** | the three messages this surface can return named a plan or an upgrade. `oauth.plan_required` (`[...slug].ts:80`, `server/api/oauth/consent.post.ts:85`), `mcp_cloud.monthly_limit` (`server/utils/mcp-cloud-proxy.ts`) and the media storage-quota error (new `mcp_cloud.storage_quota_exceeded`, `server/utils/mcp-media-facet.ts`) now state the fact and where the owner can see it. The consent page's ineligible badge reads "Plan does not include MCP Cloud". In-app Studio copy is unchanged |
| 12 | Legal + docs URLs live | **Met** | 200 on 2026-11-02: `contentrain.io/legal/terms`, `/legal/privacy-policy`, `/legal/mcp-connector-privacy`, `docs.contentrain.io/developer/mcp-cloud` |
| 13 | Support URL | **In progress** | `https://contentrain.io/support` is being built on iterum; on 2026-11-02 it still 301s to `/`. Check it answers 200 before submitting |
| 14 | Data residency (OpenAI) | **Account item** | not on the 2026-11-02 submission page; submit from a global-residency project (§1) |

### Review account — what it needs (founder creates it; identities stay out of this repo)

**Hard line: the reviewer must see 16 tools, not 11.** Steps 2 and 3 make the
project media-enabled; check `tools/list` returns 16 before sending
credentials.

1. Set `NUXT_REVIEW_ACCOUNT_EMAIL` + `NUXT_REVIEW_ACCOUNT_PASSWORD` (≥16
   chars) on the prod Studio service **first**; the first
   `/auth/review-login` creates the user and its `primary` workspace. Never
   insert the user by hand.
2. The workspace must resolve to a plan with `api.mcp_cloud_oauth` and
   `media.upload` (Starter or above) **through billing**.
   `resolveWorkspaceBilling` → `getEffectivePlan` returns `workspaces.plan`
   only while the workspace has a payment account whose subscription is
   `active` (or `trialing`, `past_due`, or canceled inside the paid period);
   with no payment account it returns `free`
   (`server/utils/billing.ts`, `resolveBillingState`). So setting
   `workspaces.plan` alone gives nothing, a hand-written `payment_accounts`
   row would be a subscription Polar does not know about, and a trial ends
   inside a review cycle. The entitlement has to be a real subscription.
3. A GitHub App installation on the workspace and the demo repository
   connected as a project, with `cdn_enabled` on. An installation binds to
   **one** workspace (`server/api/github/setup.get.ts` answers 409 when it is
   already bound elsewhere), so the demo repository has to live where an
   installation is free to bind to the review workspace. Media also needs the
   workspace to have an owner (`mcp-cloud-proxy.ts`, `mediaEligible`); the
   review user owns its `primary` workspace.
4. The project's workflow is `auto-merge`, so a reviewer's write is visible
   on the next read. The demo repository's `.contentrain/config.json` sets
   it; on Starter and above `review` would hold every write for approval.
5. The demo dataset is a private copy of `contentrain-starter-astro-blog`
   (never the public starter itself: reviewer writes auto-merge), with one
   added commit:
   - models, unchanged from the starter: `site-settings`, `navigation`,
     `footer`, `seo-defaults` (singletons, domain `system`); `author`,
     `blog-category` (collections) and `blog-post` (documents), domain
     `editorial`; all i18n;
   - locales `en` (default) and `de`. `de` covers `site-settings`,
     `navigation`, `seo-defaults`, all three categories, the author
     `esra-yilmaz` and the post `designing-calm-interfaces`;
   - four gaps on purpose, which `contentrain validate` reports and nothing
     else: no `de` footer (error), no `de` entry for the author
     `kerem-dogan`, and no `de` file for the posts
     `shipping-with-a-clear-content-model` and
     `what-modern-starters-actually-need` (warnings);
   - the starter's images are remote URLs, not library assets. The media
     library lives in Studio's storage, not in the repository, so after the
     project is connected **upload 2 images** in the project's Media panel
     (e.g. the starter's `media/cover.png` and `media/mobile.png`).
6. No MFA, no email/SMS step, reachable from the public internet.
7. After each cycle: reset the repository's `contentrain` branch to the
   demo commit, delete media the reviewer added, revoke the grants in
   Connected Apps, and rotate or unset both env values.

## 9. Portal answers (paste-ready, 2026-11-02)

The listing copy for Claude is copied verbatim from
`AI_DIRECTORY_POSITIONING.md` in `Contentrain/ai`, which stays the source: if
the two differ, that file wins and this section is updated. The OpenAI copy
below is new and written to OpenAI's limits; it follows the same spine.

### Shared facts

| Field | Value |
|---|---|
| Name | `Contentrain` |
| Slug (Claude, permanent) | `contentrain` |
| Server URL | `https://studio.contentrain.io/api/mcp/remote` (streamable HTTP, same URL for every user) |
| Auth | OAuth 2.1 + PKCE S256; CIMD preferred, DCR fallback; scopes `content:read`, `content:write`, `project:metadata`, `media:read`, `media:write`, `offline_access` |
| Website | `https://contentrain.io` |
| Documentation | `https://docs.contentrain.io/developer/mcp-cloud` |
| Privacy policy | `https://contentrain.io/legal/mcp-connector-privacy` (connector addendum; the general policy is `https://contentrain.io/legal/privacy-policy`) |
| Terms of service | `https://contentrain.io/legal/terms` |
| Support | `https://contentrain.io/support` (being built; §8 gap 13), email `support@contentrain.io` |
| Icon | `public/logo/icon-color-bg.svg` (square, 300×300 viewBox) exported to a 512×512 PNG |
| Reads, writes, or both | Both. Reads and writes are separate tools, each annotated |
| First-party API | Yes. The server is Contentrain's own, on Contentrain's domain |
| Tools | 16 tools on a media-enabled project, 11 otherwise (MCP 3.11.24, from code). The review project is media-enabled, so reviewers see 16 |
| Demo video | founder |

### Claude listing

- **One-liner:** `Edit your Git-backed product content, safely`
- **Categories:** Developer Tools (primary), CMS & Web (secondary). "CMS & Web"
  is the portal's category label, taken from the positioning file; re-check
  it against the portal's own list before submitting.
- **Description** (verbatim from `AI_DIRECTORY_POSITIONING.md`, ~1,400 chars):

  > Contentrain turns your product's content — UI copy, docs, structured
  > entries — into a typed, reviewable layer that lives in your own Git
  > repository.
  >
  > Connect Claude to a Contentrain project and it can read your content
  > models, list and inspect entries, and make changes that land as real Git
  > commits on a review branch — never as unreviewed writes to your main
  > branch. Every write is validated against your schema first, so an agent
  > cannot invent a field, break a locale, or corrupt a model.
  >
  > • Ask what content exists — models, fields, entries, locales, branch status
  > • Draft, update, and delete entries across collections, singletons,
  >   documents, and dictionaries
  > • Work in any configured locale and keep translations consistent
  > • Validate a project and get an actionable report before publishing
  > • Manage media assets on eligible plans
  >
  > You authorize one project at a time through OAuth with explicit scopes;
  > read-only and destructive tools are separately annotated; writes follow
  > your project's review or auto-merge workflow; access is revocable
  > instantly from Connected Apps.
  >
  > Content stays as plain JSON and Markdown in your repo — no vendor database
  > lock-in. The developer packages (CLI, MCP server, SDK) are MIT-licensed
  > and the Studio core is open source.
  >
  > Requires a Contentrain Studio account with a connected repository.

- **Use cases** (from the positioning file): (1) rescue hardcoded strings into
  governed content, (2) add and maintain locales as a normal content
  operation, (3) let non-developers and agents edit product content without
  touching source, (4) keep AI-generated copy inside a schema and a review
  workflow.
- **Example prompts** (against the demo project):
  1. `What content models and locales does my Contentrain project have?`
  2. `List the English blog posts with their authors and publish dates.`
  3. `Which content is still missing a German translation?`
  4. `Shorten the English excerpt of "Designing Calm Interfaces For Product Teams" to one sentence.`
- **Test & launch:** the review account (§8 spec), then: open
  `https://studio.contentrain.io/auth/review-login`, sign in, add the server
  URL as a custom connector, approve the consent page for the demo project,
  then run the five positive test cases below.

### OpenAI plugin

- **displayName** (≤30): `Contentrain`
- **shortDescription** (≤30): `Edit Git-backed content safely` (30)
- **description** (≤4000):

  > Contentrain keeps your product's content — UI copy, docs, structured
  > entries and translations — as typed JSON and Markdown in your own Git
  > repository, and lets ChatGPT read and change it without touching your
  > source code.
  >
  > After you connect a Contentrain Studio project, you can ask what content
  > exists, list and read entries in any configured locale, and create,
  > update or delete entries in collections, singletons, documents and
  > dictionaries. Every write is validated against the project's schema
  > before it is committed, so a field that does not exist or a value of the
  > wrong type is refused with a message saying what to fix. Writes land as
  > Git commits on a separate content branch and then follow the project's
  > own workflow: merged automatically, or held for a reviewer in Studio.
  > Nothing is written straight to your main branch.
  >
  > When media is enabled for the project, ChatGPT can also list the media
  > library, read an asset's details, add an image from a URL you give it,
  > edit alt text, tags and file names, and delete an asset.
  >
  > Limitations: one project per connection; Contentrain does not generate
  > images; merging, branch management and project setup stay in Contentrain
  > Studio; deleting an asset does not update the entries that reference it.
  >
  > You sign in with your Contentrain Studio account and approve exactly
  > which permissions ChatGPT gets. You can revoke access at any time from
  > Connected Apps in Studio. Requires a Contentrain Studio account with a
  > connected GitHub repository.

- **Starter prompts** (≤3, ≤128 chars, no @mentions):
  1. `What content models and locales does my Contentrain project have?`
  2. `List the English blog posts with their authors and publish dates.`
  3. `Which content is still missing a German translation?`
- **Release notes (first version):** `First release: read, create, update and delete Contentrain content and media from ChatGPT, with schema validation and Git-backed history.`

### Test cases — 5 positive (against the §8 demo project)

Each write case uses a path that keeps unrelated data: a document save merges
the frontmatter it is sent with the file's, and a new collection entry adds a
key. A singleton save or an update to an existing collection entry replaces
the whole entry (see the `content_save` note below), so no case depends on it.

| # | Scenario | Prompt | Expected tools | Expected result |
|---|---|---|---|---|
| 1 | Explore the project | `What content models and locales does my Contentrain project have?` | `contentrain_status`, then `contentrain_describe` if needed | Names the 7 models — `site-settings`, `navigation`, `footer`, `seo-defaults` (singletons), `author`, `blog-category` (collections), `blog-post` (documents) — and the locales `en` (default) and `de` |
| 2 | Read entries with relations | `List the English blog posts with their authors and publish dates.` | `contentrain_content_list` (`blog-post`, `en`; `author` if relations are not resolved) | The 3 posts — "Designing Calm Interfaces For Product Teams" (Esra Yilmaz, 2026-03-12), "Shipping Faster With A Clear Content Model" (Kerem Dogan, 2026-02-21), "What Modern Starters Actually Need" (Esra Yilmaz, 2026-01-30) |
| 3 | Find missing translations | `Which content is still missing a German translation?` | `contentrain_validate` (or `contentrain_content_list` per locale) | Names the four gaps: the `de` footer, the author Kerem Dogan, and the posts "Shipping Faster With A Clear Content Model" and "What Modern Starters Actually Need" |
| 4 | Fill one gap | `Add a German version of the author entry for Kerem Dogan, translating his role and bio.` | `contentrain_content_list` (`author`, `en`), `contentrain_content_save` (`author`, `de`, id `kerem-dogan`), `contentrain_validate` | Saves a `de` entry with `name`, a German `role` and `bio`, and the same `avatar`; validation no longer reports the author gap; the `en` entry is unchanged |
| 5 | Use the media library | `Show the images in my media library and use the first one as the cover image of "Designing Calm Interfaces For Product Teams".` | `contentrain_media_list`, `contentrain_content_save` (`blog-post`, `en`, slug `designing-calm-interfaces`, `cover_image` only) | Lists the 2 uploaded images; the post's `en` `cover_image` is the first image's delivery URL, and its title, excerpt and body are unchanged |

After a write (cases 4 and 5), `contentrain_content_save` may report
`git.action: pending-review` even on this auto-merge project. The merge lands
within seconds, so list the entries again before checking the result.

### Test cases — 3 negative

| # | Prompt | Reason | Expected response |
|---|---|---|---|
| 1 | `Generate a new cover image for my latest blog post.` | Contentrain stores and serves images; it does not generate them | Says it cannot generate images; offers to add an image from a URL the user provides (`contentrain_media_ingest`) or to pick one from the library |
| 2 | `Merge my content changes into main and deploy the site.` | Merging and deploying are not tools on this surface; they belong to Contentrain Studio and the user's own hosting | Explains that writes already follow the project's workflow (auto-merge or review in Studio) and that deploying is outside Contentrain; calls no tool |
| 3 | `Delete all my blog posts.` | Bulk deletion is irreversible and needs explicit confirmation | Asks the user to confirm before calling `contentrain_content_delete` (the tool itself requires `confirm: true`) |

### Annotation justifications (16 remote tools, MCP 3.11.24)

| Tool | readOnly | destructive | openWorld | Justification |
|---|:---:|:---:|:---:|---|
| `contentrain_status` | true | false | false | Returns project config, models and status; changes nothing |
| `contentrain_describe` | true | false | false | Returns one model's schema; changes nothing |
| `contentrain_describe_format` | true | false | false | Returns the content-format reference; changes nothing |
| `contentrain_content_list` | true | false | false | Lists and reads entries; changes nothing |
| `contentrain_media_list` | true | false | false | Lists the project's media library; changes nothing |
| `contentrain_media_get` | true | false | false | Reads one asset's details; changes nothing |
| `contentrain_model_save` | false | **true** | false | Replaces a model's whole definition (not a merge), which OpenAI counts as destructive. The change lands as a Git commit on a separate content branch, never on main, and the previous definition stays in Git history |
| `contentrain_vocabulary_save` | false | false | false | Adds or updates vocabulary terms and merges with the existing ones; omitted terms are untouched; committed to Git |
| `contentrain_content_save` | false | **true** | false | Creates or updates entries after schema validation, as a Git commit on a separate content branch, never on main. Updating a singleton or an existing collection entry replaces it with the data sent, which OpenAI counts as destructive; the previous version stays in Git history. See the note below on what an update replaces |
| `contentrain_validate` | false | false | false | Marked as a write because its `fix` option can rewrite content files (sorting, missing locale files); it deletes no entries |
| `contentrain_media_update` | false | false | false | Changes an asset's alt text, tags or file name; the file itself is not touched |
| `contentrain_model_delete` | false | true | false | Removes a model with its content and metadata; requires `confirm: true` |
| `contentrain_vocabulary_delete` | false | true | false | Removes vocabulary terms; requires `confirm: true` |
| `contentrain_content_delete` | false | true | false | Removes entries or dictionary keys; requires `confirm: true` |
| `contentrain_media_delete` | false | true | false | Removes an asset from storage; requires `confirm: true`; entries that reference it are not rewritten |
| `contentrain_media_ingest` | false | false | **true** | Fetches a URL the user supplies from the public internet (server-side, with SSRF, MIME-type and size checks) and stores it as a new asset; it overwrites nothing |

`contentrain_content_save` is `destructiveHint: true` and `idempotentHint:
false` from MCP 3.11.23. What an update replaces depends on the kind (MCP
`planContentSave`): a document merges the frontmatter it is sent with the
file's and keeps the body unless `body` is sent; a dictionary merges keys; a
**singleton** or an existing **collection entry** is replaced by the data
sent, so fields left out are removed. Under OpenAI's definition (overwriting
counts as destructive) that is the same class as `model_save`. A collection
save without an id adds a new entry on every call, so repeating it is not a
no-op. Every version stays in Git history.

### Domain challenge (OpenAI, step 1 of §6)

1. Start the plugin draft; the portal shows a verification token.
2. Set `NUXT_OPENAI_APPS_CHALLENGE` to that token on the prod service.
3. Check `https://studio.contentrain.io/.well-known/openai-apps-challenge`
   returns the token as `text/plain`.
4. Click verify in the portal; unset the variable afterwards (the route goes
   back to 404).
