# Remote MCP — Directory Submission Runbook (internal)

Operator playbook for listing Studio's remote MCP endpoint
(`https://studio.contentrain.io/api/mcp/remote`) in the **Claude
Connectors Directory** and the **OpenAI Apps / plugins universal
directory** (covers ChatGPT + Codex). User-facing docs live in
[REMOTE_MCP.md](./REMOTE_MCP.md).

> **The origin is contractual.** OpenAI treats a change of scheme/host/port
> as a brand-new app (path changes ride the version flow); Claude caches
> discovery documents keyed by URL. Submit with the production origin only
> — never staging — and never change the PRM `resource` string after
> listing.

## 1. Organizational prerequisites (weeks of lead time — start first)

- [ ] **Claude**: Team or Enterprise org with *directory management*
      access; submissions run inside claude.ai → Admin settings →
      Directory. Escalations: `mcp-review@anthropic.com`.
- [ ] **OpenAI**: organization verification under the publishing name
      (Platform Dashboard), `api.apps.write` permission, and a
      **global-residency** project (EU-residency projects cannot submit).
- [ ] Public docs URL, privacy policy URL and support contact live on
      contentrain.io (submission forms require all three).

## 2. Technical prerequisites (this repo)

- [ ] Production runs the managed pair with `NUXT_PUBLIC_SITE_URL=https://studio.contentrain.io`.
- [ ] Discovery chain answers on the production origin:
      `/.well-known/oauth-protected-resource/api/mcp/remote`,
      `/.well-known/oauth-authorization-server`, and a bare
      `POST /api/mcp/remote` returns 401 + `WWW-Authenticate`.
- [ ] **OpenAI domain verification**: set `NUXT_OPENAI_APPS_CHALLENGE` to
      the token issued by the plugin portal; confirm
      `/.well-known/openai-apps-challenge` serves it; unset after
      verification completes.
- [ ] **Review account**: set `NUXT_REVIEW_ACCOUNT_EMAIL` +
      `NUXT_REVIEW_ACCOUNT_PASSWORD` (≥16 chars) for the review window.
      Reviewers sign in at `/auth/review-login` — no OAuth/MFA/email
      confirmation (OpenAI hard requirement). Prepare the account as a
      *fully populated* workspace: connected repo with real content
      models/entries, plan that includes `api.mcp_cloud_oauth`, GitHub App
      installed. Rotate/unset the password after each review cycle.

## 3. Upstream `@contentrain/mcp` checklist (target: 1.9.0)

Audit of the installed 1.8.1 annotations (all 19 tools):

- [x] `title` present on every tool
- [x] `readOnlyHint` / `destructiveHint` correct (delete tools carry
      `destructiveHint: true`)
- [x] Tool names ≤ 64 chars
- [ ] **`openWorldHint` missing on all 19 tools** — required by OpenAI's
      plugin review (Claude doesn't require it). Add upstream.
- [ ] Consider `destructiveHint: true` for `contentrain_bulk` (bulk
      operations can include deletes).
- [ ] **Server `instructions`** — not supported by
      `startHttpMcpServerWith` in 1.8.1. When it lands, write them
      deliberately and keep ≤512 chars self-contained: OpenAI snapshots
      instructions into the versioned API contract at scan time.
- [ ] **1.9.0 Studio integration** (from upstream release notes): pass a
      `sessionFingerprint` derived from the same `x-cr-*` headers
      `resolveProvider` reads (`server/plugins/mcp-cloud-server.ts`), and
      evaluate the exported `TOOL_REQUIREMENTS` for the media-phase
      scope→tool mapping (`server/utils/mcp-tool-classes.ts`).
- [ ] After any MCP bump: diff the git internals and do a real staging
      content save before trusting the mocked test suite.

## 4. Manual test matrix (run on staging first, then production origin)

| # | Client | Steps | Pass criteria |
|---|--------|-------|---------------|
| 1 | MCP Inspector | Point at `/api/mcp/remote`; walk discovery → register/CIMD → consent → `tools/list`; exercise EVERY tool once | Each tool returns a non-generic response; Claude submission requires confirming this |
| 2 | Claude custom connector | Settings → Connectors → add the URL | Connect card appears from the bare 401; consent shows the client host; tools run |
| 3 | Claude Code | `claude mcp add --transport http contentrain <url>` | Loopback ephemeral-port callback works (port-agnostic redirect match) |
| 4 | ChatGPT developer mode | Add MCP server in Settings → Plugins | CIMD/DCR registration + consent complete; tools listed |
| 5 | Codex | `[mcp_servers.contentrain]` in config.toml → `codex mcp login contentrain` | DCR path completes; tools run |
| 6 | Scope step-up | Connect read-only, call `contentrain_content_save` | 403 `insufficient_scope` → client re-prompts consent → retry succeeds |
| 7 | Refresh rotation | Stay connected > 1h, call a tool | Silent refresh; no re-auth prompt |
| 8 | Revocation | Disconnect in Settings → Connected Apps | Client's next call prompts a clean re-authorization |
| 9 | Write path | `contentrain_content_save` on a test project | `cr/*` branch lands + auto-merge reconcile fires (or waits on review-gated projects) |

## 5. Claude submission (claude.ai → Admin settings → Directory)

1. Run the [pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria).
2. Portal steps: connection (production URL, streamable HTTP, "every user
   connects to the same URL"), tools sync (annotations must be clean),
   listing (name ≤100, tagline ≤55, description ≤2000, categories, docs +
   privacy URLs, support contact, icon, **permanent slug**), use cases,
   company, authentication (**OAuth with CIMD/DCR** — out-of-the-box
   modes), data handling (first-party API), test & launch (review-account
   credentials + step-by-step access instructions + confirmation every
   tool was exercised), compliance acknowledgments.
3. Listings start as *community connector* (automated scan); *verified*
   escalation is automatic — no action needed.

## 6. OpenAI submission (plugin portal — one submission covers ChatGPT + Codex)

1. Verify the domain (`NUXT_OPENAI_APPS_CHALLENGE`, §2).
2. Create the plugin draft → add MCP server details → **Scan Tools**
   (snapshots names/descriptions/schemas/annotations/`_meta`/instructions
   as a versioned contract — changing any of these later requires a new
   version submission).
3. Provide: app name/logo/description, company + privacy URLs, review
   credentials (§2 review account — no MFA/email confirmation), test
   prompts with expected responses (verify on web AND mobile),
   justifications for the annotation values.
4. After approval, publish from the portal. Add the per-app redirect URI
   (`https://chatgpt.com/connector/oauth/{callback_id}`) to nothing — CIMD
   makes it self-serve; it's listed here only as the value you'll see in
   their app management page.

## 7. Post-listing invariants

- Never change the PRM `resource` string or the endpoint origin.
- Discovery documents are cached ~5 min globally by Claude; scope changes
  propagate on that horizon.
- Loopback MCP sessions are per-instance (15 min TTL): keep a single
  replica or sticky sessions in front of `/api/mcp/remote`.
- Tool-surface changes (names/descriptions/schemas via an MCP bump)
  require an OpenAI version resubmission — batch them.
