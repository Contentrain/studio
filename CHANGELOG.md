# Changelog


## v0.2.0

[compare changes](https://github.com/Contentrain/studio/compare/v0.2.0-beta.1...v0.2.0)

### 🩹 Fixes

- **docker:** Carry the migration runner + SQL lineage in the runtime image ([#149](https://github.com/Contentrain/studio/pull/149))
- **docker:** Un-ignore supabase/migrations so the runtime COPY resolves ([#150](https://github.com/Contentrain/studio/pull/150))
- **chat:** Stop silent output-token truncation from stranding agent writes ([#151](https://github.com/Contentrain/studio/pull/151))
- **cdn:** Honor default locale, locale_strategy, and singleton status in builds ([#152](https://github.com/Contentrain/studio/pull/152))
- **cdn:** Skip content-less builds so the manifest never outruns the bundle ([#153](https://github.com/Contentrain/studio/pull/153))
- **cdn:** Serialize builds per project to stop concurrent-build corruption ([#154](https://github.com/Contentrain/studio/pull/154))
- **content:** Pin non-i18n meta to default locale; upgrade contentrain to 2.x ([#155](https://github.com/Contentrain/studio/pull/155))
- **chat:** Render agent turns as chronological segments with scroll-follow ([#159](https://github.com/Contentrain/studio/pull/159))
- **chat:** Keep the full agent trace visible in history and never end a turn without a summary ([#160](https://github.com/Contentrain/studio/pull/160))
- **chat:** Stream updates never re-rendered — mutate the assistant message via its reactive proxy ([#161](https://github.com/Contentrain/studio/pull/161))

### 💅 Refactors

- **content:** Delegate content-dir resolution to MCP contentDirPath (mcp 2.1.0) ([#162](https://github.com/Contentrain/studio/pull/162))

### 📖 Documentation

- **mcp:** Refresh remote-MCP submission runbook ([#148](https://github.com/Contentrain/studio/pull/148))

### ❤️ Contributors

- AHMET BAYHAN BAYRAMOGLU ([@ABB65](https://github.com/ABB65))

## v0.2.0-beta.1

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0...v0.2.0-beta.1)

### 🚀 Enhancements

- **ai:** Add Claude Sonnet 5 + single-source chat model catalog ([#113](https://github.com/Contentrain/studio/pull/113))
- **durability:** Alert on swallowed R2-teardown failures + require explicit CDN bucket ([#121](https://github.com/Contentrain/studio/pull/121))
- **cdn:** Emit per-locale content bundles for single-fetch delivery ([#125](https://github.com/Contentrain/studio/pull/125))
- **providers:** Add auth/database provider selectors behind boot validation ([#126](https://github.com/Contentrain/studio/pull/126))
- **db:** Portable migration lineage — plain-Postgres auth shim, runner, CI proof ([#127](https://github.com/Contentrain/studio/pull/127))
- **db:** Postgres DatabaseProvider core — client, RLS helpers, first 4 modules, contract suite ([#128](https://github.com/Contentrain/studio/pull/128))
- **db:** Postgres provider — projects, usage, conversations (43 methods) + conversation delete-policy fix ([#130](https://github.com/Contentrain/studio/pull/130))
- **db:** Postgres DatabaseProvider COMPLETE — final 6 modules + delete-safe FK fixes ([#131](https://github.com/Contentrain/studio/pull/131))
- **auth:** Managed AuthProvider — the postgres pair is now selectable ([#132](https://github.com/Contentrain/studio/pull/132))
- **tests:** Plain-PG test matrix + managed-pair boot smoke + provider-pair docs (Faz 4) ([#138](https://github.com/Contentrain/studio/pull/138))
- **oauth:** Studio-managed OAuth 2.1 AS for the remote MCP surface ([#141](https://github.com/Contentrain/studio/pull/141))
- **mcp:** ProjectId-less remote MCP endpoint behind the OAuth grant ([#142](https://github.com/Contentrain/studio/pull/142))
- **ui:** Connected apps panel — see and revoke remote MCP grants ([#143](https://github.com/Contentrain/studio/pull/143))
- **auth:** Directory-review support — env-gated reviewer login + submission prep ([#144](https://github.com/Contentrain/studio/pull/144))
- **mcp:** Bump @contentrain/mcp to 1.10.0 — session fingerprint + media tool classes ([#145](https://github.com/Contentrain/studio/pull/145))
- **mcp:** Media facet — the 1.10.0 media tools over MCP Cloud ([#146](https://github.com/Contentrain/studio/pull/146))

### 🔥 Performance

- ~6x fewer GitHub API calls in the agent write path (W1-W4) ([#116](https://github.com/Contentrain/studio/pull/116))
- **cdn:** Serve delivery hot path from in-process caches + conditional R2 reads ([#124](https://github.com/Contentrain/studio/pull/124))

### 🩹 Fixes

- **auth:** Keep user sessions off the service-role Supabase client ([#112](https://github.com/Contentrain/studio/pull/112))
- **content:** Add 17 dictionary keys used in code but never defined ([#114](https://github.com/Contentrain/studio/pull/114))
- **cdn:** Stop full rebuild from wiping out-of-band media binaries ([#115](https://github.com/Contentrain/studio/pull/115))
- **git:** Never auto-delete the source branch on merge (MCP 1.8.0) ([#118](https://github.com/Contentrain/studio/pull/118))
- **brain:** Full-rebuild off default branch when contentrain is missing ([#119](https://github.com/Contentrain/studio/pull/119))
- **content:** Handle document per-slug meta in status, copy-locale, and UI ([#123](https://github.com/Contentrain/studio/pull/123))
- **auth:** Pin the OAuth exchange redirect_uri to siteUrl behind proxies ([#134](https://github.com/Contentrain/studio/pull/134))
- **auth:** Let the oauth module own both dance legs — its state, its check ([#135](https://github.com/Contentrain/studio/pull/135))
- **auth:** Drop the state param from the oauth entry URL — it broke module CSRF ([#136](https://github.com/Contentrain/studio/pull/136))
- **cdn:** Derive webhook build paths from the compare API, not payload commits ([#139](https://github.com/Contentrain/studio/pull/139))
- **chat:** Refuse media-intent uploads while project CDN delivery is off ([#140](https://github.com/Contentrain/studio/pull/140))

### 🏡 Chore

- **gitignore:** Ignore .codex/ agent local configs ([#147](https://github.com/Contentrain/studio/pull/147))

### ❤️ Contributors

- AHMET BAYHAN BAYRAMOGLU ([@ABB65](https://github.com/ABB65))

## v0.1.0

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0-beta.8...v0.1.0)

### 🚀 Enhancements

- **media:** Scope foundation for the media management API ([af98d3d](https://github.com/Contentrain/studio/commit/af98d3d))
- **media:** Public media CRUD API routes (/api/media/v1) ([5541c96](https://github.com/Contentrain/studio/commit/5541c96))
- **media:** Scope selection UI for CDN/media keys ([c5fa3a1](https://github.com/Contentrain/studio/commit/c5fa3a1))
- **cdn:** CDN/media architecture alignment — edition/plan gating, Assets↔CDN, upsell ([#74](https://github.com/Contentrain/studio/pull/74))
- **observability:** Add Sentry error & performance monitoring ([#79](https://github.com/Contentrain/studio/pull/79))
- **editor:** Source-mode markdown editor + agent markdown authoring guide ([#82](https://github.com/Contentrain/studio/pull/82))
- **seo:** Add page titles, head meta, and Open Graph tags ([#84](https://github.com/Contentrain/studio/pull/84))
- **cdn:** Public media delivery + build-time path rewrite ([#83](https://github.com/Contentrain/studio/pull/83))
- **chat:** Attach external files and links to conversations ([#87](https://github.com/Contentrain/studio/pull/87))
- **agent:** Align system prompt + enforcement with governance and edition ([#88](https://github.com/Contentrain/studio/pull/88))
- **agent:** Publish/media/branch tools + relation integrity at save ([#89](https://github.com/Contentrain/studio/pull/89))
- Array<object> field editing + explicit chat attachment intent ([#90](https://github.com/Contentrain/studio/pull/90))

### 🩹 Fixes

- **media:** Reuse existing cdn.key_mismatch + chat.rate_limited error keys ([bca7b7f](https://github.com/Contentrain/studio/commit/bca7b7f))
- **e2e:** Target CDN key-name input by type (scope checkboxes broke the first-input locator) ([81c62f6](https://github.com/Contentrain/studio/commit/81c62f6))
- **media:** Attribute API-key uploads to the workspace owner (uploaded_by uuid FK) ([c342e10](https://github.com/Contentrain/studio/commit/c342e10))
- **media:** Gate the media API on CDN activation (cdn_enabled) ([1ee8612](https://github.com/Contentrain/studio/commit/1ee8612))
- **billing:** Grant the free trial once per workspace + fix plan modal ([#75](https://github.com/Contentrain/studio/pull/75))
- **billing:** Surface a clean error when the payment provider call fails ([#76](https://github.com/Contentrain/studio/pull/76))
- **cdn:** Move key-scope checkboxes below the PERMISSIONS label ([#77](https://github.com/Contentrain/studio/pull/77))
- **chat:** Replace retired Claude model IDs ([#80](https://github.com/Contentrain/studio/pull/80))
- **config:** Fail boot if the service-role key isn't actually service_role ([#81](https://github.com/Contentrain/studio/pull/81))
- **content:** Merge document saves with the existing entry ([#85](https://github.com/Contentrain/studio/pull/85))
- **content:** Resolve document paths under the model id ([#85](https://github.com/Contentrain/studio/pull/85), [#86](https://github.com/Contentrain/studio/pull/86))
- **chat:** Turn streaming, document date validation, and live context reactivity ([#91](https://github.com/Contentrain/studio/pull/91))
- **content:** Merge partial collection/singleton saves instead of replacing ([#92](https://github.com/Contentrain/studio/pull/92))
- **members:** Drop non-existent workspace_id from project_members insert ([#93](https://github.com/Contentrain/studio/pull/93))
- **workspace:** Owner keeps owner role after inviting a member ([#94](https://github.com/Contentrain/studio/pull/94))
- Plan info lost after deploy until redeploy (ee bridge / sharp native load) ([#95](https://github.com/Contentrain/studio/pull/95))
- **webhooks:** Add missing dictionary keys + fix header spacing ([#100](https://github.com/Contentrain/studio/pull/100))
- **forms:** Render "None" captcha option in form settings ([#101](https://github.com/Contentrain/studio/pull/101))
- **content:** Status badge picker with loading state ([#102](https://github.com/Contentrain/studio/pull/102))
- **starters:** Add missing common.all string + stop modal height jump ([#104](https://github.com/Contentrain/studio/pull/104))
- **billing:** Use real trial_end, never the billing period end ([#103](https://github.com/Contentrain/studio/pull/103))
- **branches:** Decode percent-encoded branch route param ([#105](https://github.com/Contentrain/studio/pull/105))

### 📖 Documentation

- Close mobile responsive shell todo (shipped since v0.1.0-beta.1) ([14b5694](https://github.com/Contentrain/studio/commit/14b5694))

### 🏡 Chore

- Standardize contentrain.io email addresses ([aef6f4d](https://github.com/Contentrain/studio/commit/aef6f4d))
- **deps-dev:** Bump vue-tsc from 3.2.6 to 3.3.6 ([#99](https://github.com/Contentrain/studio/pull/99))

### ❤️ Contributors

- AHMET BAYHAN BAYRAMOGLU ([@ABB65](https://github.com/ABB65))
- Contentrain <mcp@contentrain.io>

## v0.1.0-beta.8

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0-beta.7...v0.1.0-beta.8)

### 🚀 Enhancements

- **mcp-cloud:** Add license entries + Supabase migration (Faz S6 ön-hazırlık) ([22fe286](https://github.com/Contentrain/studio/commit/22fe286))
- **mcp-cloud:** Wire hosted HTTP endpoint + key management (Faz S6) ([325d39e](https://github.com/Contentrain/studio/commit/325d39e))
- **mcp-cloud:** Workspace settings tab for API key management (Faz S6) ([218c0dc](https://github.com/Contentrain/studio/commit/218c0dc))
- **pricing:** Simplify free, boost starter, upgrade pro, wire enterprise CTA (P1-P3, P7) ([7e668b5](https://github.com/Contentrain/studio/commit/7e668b5))
- **mcp-cloud:** Wire Stripe overage billing (P5) ([00482ca](https://github.com/Contentrain/studio/commit/00482ca))
- **billing:** Trial ending reminder emails (P8) ([5f4ca43](https://github.com/Contentrain/studio/commit/5f4ca43))
- **billing:** Normalise payment state into payment_accounts + outbox ([6566864](https://github.com/Contentrain/studio/commit/6566864))
- **billing:** Add polar payment plugin and usage outbox drainer ([2465117](https://github.com/Contentrain/studio/commit/2465117))
- **billing:** Activate polar, wire usage meters, add setup tooling ([44621b9](https://github.com/Contentrain/studio/commit/44621b9))
- **scripts:** Content-driven polar-sync (products + prices + meters) ([4bd9008](https://github.com/Contentrain/studio/commit/4bd9008))
- **email:** Shared branded layout and Polar webhook notifications ([f732f4b](https://github.com/Contentrain/studio/commit/f732f4b))
- **polar:** Add env-file support for polar sync script ([a98cfd8](https://github.com/Contentrain/studio/commit/a98cfd8))
- **legal:** Editions, deployment profiles, and licensing surface ([f73b192](https://github.com/Contentrain/studio/commit/f73b192))
- **runtime:** Deployment profiles + edition-aware license system ([85dbeb8](https://github.com/Contentrain/studio/commit/85dbeb8))
- **ui:** Edition-aware UI surfaces for all deployment profiles ([625c38a](https://github.com/Contentrain/studio/commit/625c38a))
- **enforcement:** Orphan feature cleanup — enforce or flag roadmap ([7ee0c42](https://github.com/Contentrain/studio/commit/7ee0c42))
- **github-app:** Connect-existing flow, revoke on delete, ownership verification ([253be4a](https://github.com/Contentrain/studio/commit/253be4a))
- **github-app:** Repo-level access lifecycle (revoke/delete/rename handling) ([dc05977](https://github.com/Contentrain/studio/commit/dc05977))
- **billing:** Revert reserved message slot on failed/aborted chats ([28a2e95](https://github.com/Contentrain/studio/commit/28a2e95))
- **chat:** Durable internal tool trace persistence ([29c821c](https://github.com/Contentrain/studio/commit/29c821c))
- **content-engine:** Align with @contentrain/mcp 1.5.0 / query 6 / types 0.5.1 ([75a76ae](https://github.com/Contentrain/studio/commit/75a76ae))
- **mcp-cloud:** Honor project workflow + plan for external writes; document server layer ([47d5ca5](https://github.com/Contentrain/studio/commit/47d5ca5))
- **billing:** Align plan modal, paywall, and trial UX end-to-end ([de5370f](https://github.com/Contentrain/studio/commit/de5370f))
- **mcp-cloud:** Enforce tool allowlist, fix quota semantics, improve onboarding ([cc5c5e1](https://github.com/Contentrain/studio/commit/cc5c5e1))

### 🔥 Performance

- **ai:** Anthropic prompt cache + cache token accounting ([0bd4faf](https://github.com/Contentrain/studio/commit/0bd4faf))

### 🩹 Fixes

- **ci:** Use CHANGELOG.md for release notes instead of GitHub auto-generated ([056bab2](https://github.com/Contentrain/studio/commit/056bab2))
- **config:** Set root directory for Vitest configuration ([5f16a3a](https://github.com/Contentrain/studio/commit/5f16a3a))
- **mcp-cloud:** Close 4 launch blockers from deep review (C1-C4) ([1ce0bac](https://github.com/Contentrain/studio/commit/1ce0bac))
- **ui:** Use valid annon--comment-dots icon for ai_messages ([d9c2ce0](https://github.com/Contentrain/studio/commit/d9c2ce0))
- **build:** Generate contentrain client before nuxt build ([6d8610c](https://github.com/Contentrain/studio/commit/6d8610c))
- **ci:** Pin pnpm to 10.26.2 in action-setup v6 ([#26](https://github.com/Contentrain/studio/pull/26))
- **deploy:** Disable healthcheck for Railway routing debug ([#27](https://github.com/Contentrain/studio/pull/27))
- **db:** Restore Supabase role grants missing from baseline ([#28](https://github.com/Contentrain/studio/pull/28))
- **settings:** Plan display, self-host UX, trunk-based branch model ([#34](https://github.com/Contentrain/studio/pull/34))
- **content:** Align .contentrain billing data with canonical license values ([b9e65cc](https://github.com/Contentrain/studio/commit/b9e65cc))
- **billing:** Resolve self-host detection across UI and server ([87c86ff](https://github.com/Contentrain/studio/commit/87c86ff))
- **ci:** Integration-test compatibility for enterprise + media enforcement ([8152271](https://github.com/Contentrain/studio/commit/8152271))
- **ci:** Production-safe deployment snapshot mutation ([0988b0b](https://github.com/Contentrain/studio/commit/0988b0b))
- **ee:** Surface bridge load failures instead of silent fallback ([eb97b41](https://github.com/Contentrain/studio/commit/eb97b41))
- **github:** Pass workspace id as state to App install url ([9b1cc03](https://github.com/Contentrain/studio/commit/9b1cc03))
- **ee:** Eliminate boot-time race that latched deployment as community ([d23a32e](https://github.com/Contentrain/studio/commit/d23a32e))
- **billing:** Redirect free workspace to checkout instead of alerting ([67b029e](https://github.com/Contentrain/studio/commit/67b029e))
- **github-app:** Reconnect uses POST /api/auth/login, not bare URL ([3fe3f82](https://github.com/Contentrain/studio/commit/3fe3f82))
- **chat:** Remove non-existent status/workspace_id from conversations SELECT ([237a112](https://github.com/Contentrain/studio/commit/237a112))
- **ci:** Wait for e2e port to free between suite spawns ([8f0c096](https://github.com/Contentrain/studio/commit/8f0c096))
- **billing:** Correct Conversation API actor model + usage table ([23631b2](https://github.com/Contentrain/studio/commit/23631b2))
- **chat:** Preserve assistant text blocks across tool iterations ([7d0c35b](https://github.com/Contentrain/studio/commit/7d0c35b))
- **mcp-cloud:** Pass Retry-After as number for h3 typed headers ([cf7b918](https://github.com/Contentrain/studio/commit/cf7b918))
- **chat:** Persist conversation trace rows reliably ([b890b82](https://github.com/Contentrain/studio/commit/b890b82))
- **content:** Validate document slug passed as a separate argument ([011a077](https://github.com/Contentrain/studio/commit/011a077))
- **mcp-cloud:** Exempt /api/mcp from the session auth middleware ([c1ca245](https://github.com/Contentrain/studio/commit/c1ca245))
- **auth:** Exempt forms + conversation API from session middleware ([6199538](https://github.com/Contentrain/studio/commit/6199538))
- **mcp-cloud:** Forward the client Accept header to the loopback MCP server ([4a8750f](https://github.com/Contentrain/studio/commit/4a8750f))

### 💅 Refactors

- **providers:** Adopt @contentrain/mcp RepoProvider surface (Faz S1) ([2059f13](https://github.com/Contentrain/studio/commit/2059f13))
- **content-engine:** Delegate content ops to @contentrain/mcp (Faz S2) ([a91eb78](https://github.com/Contentrain/studio/commit/a91eb78))
- **validation:** Delegate validateContent to @contentrain/mcp (Faz S3) ([9da5de9](https://github.com/Contentrain/studio/commit/9da5de9))
- **serialization:** Drop content-serialization wrapper (Faz S4) ([22f23d0](https://github.com/Contentrain/studio/commit/22f23d0))
- **billing:** Introduce payment provider plugin registry ([7b5dae1](https://github.com/Contentrain/studio/commit/7b5dae1))
- **license:** Derive PLAN_* constants from .contentrain content ([136bbac](https://github.com/Contentrain/studio/commit/136bbac))
- **chat:** Shared history builder with model/plan/source-aware budgets ([2f4e394](https://github.com/Contentrain/studio/commit/2f4e394))

### 📖 Documentation

- Reflect MCP integration + S6 prep in ROADMAP + CLAUDE.md (Faz S8) ([4a69b5e](https://github.com/Contentrain/studio/commit/4a69b5e))
- Mark S6 MCP Cloud shipped (Faz S8 cleanup) ([e72a8cd](https://github.com/Contentrain/studio/commit/e72a8cd))
- **deploy:** Align deployment docs with trunk-based flow ([577012f](https://github.com/Contentrain/studio/commit/577012f))
- **claude:** Clarify account deletion has no outbound email ([a5a2ba9](https://github.com/Contentrain/studio/commit/a5a2ba9))
- **editions:** Align long-form docs with the edition + profile model ([28534b6](https://github.com/Contentrain/studio/commit/28534b6))
- **ee:** Finalize License v1.0 from market-comparative review ([b9baa56](https://github.com/Contentrain/studio/commit/b9baa56))

### 🏡 Chore

- **deps-dev:** Bump @types/node from 25.5.2 to 25.6.0 ([#22](https://github.com/Contentrain/studio/pull/22))
- **deps-dev:** Bump @tailwindcss/vite from 4.2.1 to 4.2.2 ([#21](https://github.com/Contentrain/studio/pull/21))
- **deps-dev:** Bump the testing group with 4 updates ([#19](https://github.com/Contentrain/studio/pull/19))
- **db:** Harden baseline for portability ([#25](https://github.com/Contentrain/studio/pull/25))
- Merge main into feat/github-app-lifecycle-overhaul ([4f9cdd2](https://github.com/Contentrain/studio/commit/4f9cdd2))

### ✅ Tests

- **chat:** Update integration assertion to expect populated assistantText ([4659c05](https://github.com/Contentrain/studio/commit/4659c05))

### ❤️ Contributors

- Contentrain <ai@contentrain.io>
- AHMET BAYHAN BAYRAMOGLU ([@ABB65](https://github.com/ABB65))

## v0.1.0-beta.7

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0-beta.6...v0.1.0-beta.7)

### 🚀 Enhancements

- **api:** Add CLI integration endpoints for Studio CLI ([5824f89](https://github.com/Contentrain/studio/commit/5824f89))

### 🩹 Fixes

- **content:** Align validation/serialization tests with @contentrain/types ([32af5f0](https://github.com/Contentrain/studio/commit/32af5f0))

### 💅 Refactors

- **content:** Migrate validation and serialization to @contentrain/types ([e554bbe](https://github.com/Contentrain/studio/commit/e554bbe))

### 📖 Documentation

- Update roadmap and CLAUDE.md for CLI integration and overage billing ([1cd6dba](https://github.com/Contentrain/studio/commit/1cd6dba))

### ❤️ Contributors

- Contentrain <ai@contentrain.io>

## v0.1.0-beta.6

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0-beta.5...v0.1.0-beta.6)

### 🚀 Enhancements

- **billing:** Add overage billing system with usage dashboard ([bd981f1](https://github.com/Contentrain/studio/commit/bd981f1))

### ❤️ Contributors

- Contentrain <ai@contentrain.io>

## v0.1.0-beta.5

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0-beta.4...v0.1.0-beta.5)

### 🩹 Fixes

- **security:** Atomic plan limit checks and GDPR audit logging gaps ([5df4248](https://github.com/Contentrain/studio/commit/5df4248))

### 📖 Documentation

- Mark resolved deferred items and fix media route test mock ([42a85af](https://github.com/Contentrain/studio/commit/42a85af))

### 🏡 Chore

- **deps:** Bump docker/setup-buildx-action from 3 to 4 ([9c7aa6f](https://github.com/Contentrain/studio/commit/9c7aa6f))
- **deps:** Bump docker/login-action from 3 to 4 ([929c870](https://github.com/Contentrain/studio/commit/929c870))
- **deps:** Bump docker/build-push-action from 6 to 7 ([709cdb4](https://github.com/Contentrain/studio/commit/709cdb4))
- **deps-dev:** Bump the testing group with 4 updates ([e7525b8](https://github.com/Contentrain/studio/commit/e7525b8))
- **deps-dev:** Bump eslint from 10.0.3 to 10.2.0 in the linting group ([054c567](https://github.com/Contentrain/studio/commit/054c567))
- **deps-dev:** Bump tailwindcss from 4.2.1 to 4.2.2 ([3675b9b](https://github.com/Contentrain/studio/commit/3675b9b))
- **deps:** Bump the vue group with 2 updates ([9c9c91b](https://github.com/Contentrain/studio/commit/9c9c91b))
- **deps-dev:** Bump @types/node from 24.12.0 to 25.5.2 ([1eb0958](https://github.com/Contentrain/studio/commit/1eb0958))

### ❤️ Contributors

- Contentrain <ai@contentrain.io>

## v0.1.0-beta.4

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0-beta.3...v0.1.0-beta.4)

### 🩹 Fixes

- **billing:** Remove per-seat pricing, adopt flat-rate model ([e706bcb](https://github.com/Contentrain/studio/commit/e706bcb))
- **billing:** Align Pro seat limit to 10, remove per-seat remnants ([d2be160](https://github.com/Contentrain/studio/commit/d2be160))
- **webhooks:** Complete all 8 webhook event dispatches and fix test coverage ([c6a36e1](https://github.com/Contentrain/studio/commit/c6a36e1))

### 📖 Documentation

- Add public ROADMAP.md, align deferred items across all docs ([04134b4](https://github.com/Contentrain/studio/commit/04134b4))

### ❤️ Contributors

- Contentrain <ai@contentrain.io>

## v0.1.0-beta.3

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0-beta.2...v0.1.0-beta.3)

### 🩹 Fixes

- **release:** Include full docker build context ([3dffa99](https://github.com/Contentrain/studio/commit/3dffa99))

### 📖 Documentation

- Align studio open-core positioning ([733ae3e](https://github.com/Contentrain/studio/commit/733ae3e))

### ❤️ Contributors

- Contentrain <ai@contentrain.io>

## v0.1.0-beta.2

[compare changes](https://github.com/Contentrain/studio/compare/v0.1.0-beta.1...v0.1.0-beta.2)

### ✅ Tests

- **e2e:** Stabilize cdn panel rebuild assertion ([ce228f7](https://github.com/Contentrain/studio/commit/ce228f7))

### ❤️ Contributors

- Contentrain <ai@contentrain.io>

## 2ef41eebc54d947b051ffaf395c130b7e190ece0...HEAD

[compare changes](https://github.com/Contentrain/studio/compare/2ef41eebc54d947b051ffaf395c130b7e190ece0...HEAD)

### 🚀 Enhancements

- Add supabase auth provider, api routes, and auth UI ([d6c08d5](https://github.com/Contentrain/studio/commit/d6c08d5))
- Auth UI with contentrain SDK, annon icons, and tailwind 4 theme ([95f3cf3](https://github.com/Contentrain/studio/commit/95f3cf3))
- Add logo assets, favicon, and Radix Vue atom components ([3e65e81](https://github.com/Contentrain/studio/commit/3e65e81))
- Add Nuxt layout system with NuxtImg and workspace three-panel ([8db613a](https://github.com/Contentrain/studio/commit/8db613a))
- Auth guard with redirect, placeholder index page ([ea688b5](https://github.com/Contentrain/studio/commit/ea688b5))
- **auth:** Add auth-marketing Contentrain model and update auth layout ([77b46e3](https://github.com/Contentrain/studio/commit/77b46e3))
- **design:** Add Syne display font for headings and marketing content ([4f1df45](https://github.com/Contentrain/studio/commit/4f1df45))
- **content:** Add error page UI strings ([538cf8a](https://github.com/Contentrain/studio/commit/538cf8a))
- **workspace:** Add workspace hierarchy — User → Workspace → Project ([85c0090](https://github.com/Contentrain/studio/commit/85c0090))
- **ui:** Sidebar-first layout — kill the header, sidebar is everything ([7204796](https://github.com/Contentrain/studio/commit/7204796))
- **git:** Add GitHub App provider with installation flow ([f256aa7](https://github.com/Contentrain/studio/commit/f256aa7))
- **connect:** Add ConnectRepoDialog — no wizard, just a smart dialog ([1e9d1e5](https://github.com/Contentrain/studio/commit/1e9d1e5))
- **ui:** Add project workspace page — chat + context panel placeholders ([13a53fe](https://github.com/Contentrain/studio/commit/13a53fe))
- **ui:** Add EmptyState, Skeleton atoms and NuxtLoadingIndicator ([fb0c286](https://github.com/Contentrain/studio/commit/fb0c286))
- **ui:** Dark/light theme toggle, icon-based empty states, workspace settings ([2e3edb3](https://github.com/Contentrain/studio/commit/2e3edb3))
- **snapshot:** Content snapshot API + context panel with model list ([582cfa7](https://github.com/Contentrain/studio/commit/582cfa7))
- **sidebar:** Show models section when inside a project view ([4704605](https://github.com/Contentrain/studio/commit/4704605))
- **toast:** Add vue-sonner toast notifications + workspace save ([9082432](https://github.com/Contentrain/studio/commit/9082432))
- **content:** Model content browsing + slug editing + sidebar model selection ([7516920](https://github.com/Contentrain/studio/commit/7516920))
- **cache:** IndexedDB snapshot cache + sidebar polish + view transitions ([8e251b5](https://github.com/Contentrain/studio/commit/8e251b5))
- **viewer:** Type-aware content field display in context panel ([5849c6d](https://github.com/Contentrain/studio/commit/5849c6d))
- **viewer:** Support all 4 content kinds — collection, singleton, dictionary, document ([00f36db](https://github.com/Contentrain/studio/commit/00f36db))
- **types:** Integrate @contentrain/types v0.2.0 as shared contract ([2697502](https://github.com/Contentrain/studio/commit/2697502))
- **sidebar:** Domain-grouped model list with kind icons and entry counts ([3060b76](https://github.com/Contentrain/studio/commit/3060b76))
- **sidebar:** Collapsible domain groups + fix project nav semantics ([9f88272](https://github.com/Contentrain/studio/commit/9f88272))
- **viewer:** Markdown preview with Tailwind Typography prose classes ([faffe79](https://github.com/Contentrain/studio/commit/faffe79))
- **viewer:** Render nested objects and array-of-objects in field display ([fa62011](https://github.com/Contentrain/studio/commit/fa62011))
- **i18n:** Locale switcher in context panel header ([38e2e49](https://github.com/Contentrain/studio/commit/38e2e49))
- **git:** Implement all GitProvider write operations ([dc6a20d](https://github.com/Contentrain/studio/commit/dc6a20d))
- **engine:** Add Content Engine — validation, serialization, write path ([ede7a51](https://github.com/Contentrain/studio/commit/ede7a51))
- **chat:** Add database migration, encryption, and Anthropic SDK ([0a91f1b](https://github.com/Contentrain/studio/commit/0a91f1b))
- **chat:** Add AIProvider interface, Anthropic impl, and chat SSE endpoint ([42f9998](https://github.com/Contentrain/studio/commit/42f9998))
- **chat:** Add chat UI — composable, bubbles, tool cards, input, panel ([69cd068](https://github.com/Contentrain/studio/commit/69cd068))
- **init:** Implement project initialization flow (Path B) ([a74ce70](https://github.com/Contentrain/studio/commit/a74ce70))
- **edit:** Inline content editing — click field to edit, save creates branch ([2ac0f62](https://github.com/Contentrain/studio/commit/2ac0f62))
- **branches:** Branch management API + sidebar pending changes ([961efe0](https://github.com/Contentrain/studio/commit/961efe0))
- **chat:** Add live project state to system prompt — prevents agent loops ([668d69a](https://github.com/Contentrain/studio/commit/668d69a))
- **chat:** Add context pin + drag system — share content items with the agent ([f3f1a8f](https://github.com/Contentrain/studio/commit/f3f1a8f))
- **agent:** Comprehensive Contentrain architecture in system prompt ([fd36acc](https://github.com/Contentrain/studio/commit/fd36acc))
- **agent:** Load vocabulary + context.json, fix content_path + i18n:false paths ([5ff5688](https://github.com/Contentrain/studio/commit/5ff5688))
- **ui:** Show vocabulary + project stats in content panel overview ([a39e892](https://github.com/Contentrain/studio/commit/a39e892))
- **ui:** Add Radix Vue tooltips to project stats bar ([872308e](https://github.com/Contentrain/studio/commit/872308e))
- **engine:** Meta files, relation integrity, unique constraint, document support ([8e48c92](https://github.com/Contentrain/studio/commit/8e48c92))
- **engine:** Write context.json on every operation, clean meta on delete ([5db2d6b](https://github.com/Contentrain/studio/commit/5db2d6b))
- Entry status badges + document kind write support ([b7c101a](https://github.com/Contentrain/studio/commit/b7c101a))
- **editor:** Modal-based content editor + CRUD chat prompts ([82ce0d0](https://github.com/Contentrain/studio/commit/82ce0d0))
- Branch diff UI, role-based workflow, and GitHub webhook ([4c1ac2b](https://github.com/Contentrain/studio/commit/4c1ac2b))
- **members:** Workspace and project member management UI ([0c241ff](https://github.com/Contentrain/studio/commit/0c241ff))
- Project settings modal, vocabulary editing, and config API ([fc51890](https://github.com/Contentrain/studio/commit/fc51890))
- **chat:** Project switch reset, avatars, context attach to message ([33f669e](https://github.com/Contentrain/studio/commit/33f669e))
- **chat:** Conversation history, model selection, and API endpoints ([7d5d983](https://github.com/Contentrain/studio/commit/7d5d983))
- **ee:** Enterprise edition structure + license feature flags ([cb28512](https://github.com/Contentrain/studio/commit/cb28512))
- **ee:** Comprehensive plan-based feature gating ([226df36](https://github.com/Contentrain/studio/commit/226df36))
- Rate limiting + BYOA key management UI ([8b9b546](https://github.com/Contentrain/studio/commit/8b9b546))
- Copy_locale tool, branch protection PR fallback, command palette ([cfcadd3](https://github.com/Contentrain/studio/commit/cfcadd3))
- Auto-detect GitHub App installation on tab focus ([0902012](https://github.com/Contentrain/studio/commit/0902012))
- **cdn:** Content delivery core infrastructure ([6bc09c7](https://github.com/Contentrain/studio/commit/6bc09c7))
- **cdn:** Project settings CDN management UI ([e3b6ffa](https://github.com/Contentrain/studio/commit/e3b6ffa))
- **cdn:** Usage metering and per-key rate limiting (EE) ([ae1ea1b](https://github.com/Contentrain/studio/commit/ae1ea1b))
- **cdn:** Real-time build progress via SSE ([acc9615](https://github.com/Contentrain/studio/commit/acc9615))
- **ux:** Plan badge on workspace switcher + session persistence ([eb27d6e](https://github.com/Contentrain/studio/commit/eb27d6e))
- Comprehensive command palette with search, commands, and recents ([60985f2](https://github.com/Contentrain/studio/commit/60985f2))
- Content publish workflow + CDN status filtering ([4fb88d9](https://github.com/Contentrain/studio/commit/4fb88d9))
- **ui:** Clickable publish/unpublish status badge in collections ([367038e](https://github.com/Contentrain/studio/commit/367038e))
- Add diff-based stale object cleanup to CDN build pipeline ([c0aa0bd](https://github.com/Contentrain/studio/commit/c0aa0bd))
- Add boot-time config validation via Nitro plugin ([b793365](https://github.com/Contentrain/studio/commit/b793365))
- Add starter kit templates and show repo name without owner prefix ([c845722](https://github.com/Contentrain/studio/commit/c845722))
- Media management infrastructure — provider, migration, variants, helpers ([12dba75](https://github.com/Contentrain/studio/commit/12dba75))
- Media processing pipeline — sharp optimizer, variants, blurhash ([1e87efb](https://github.com/Contentrain/studio/commit/1e87efb))
- Media API routes — upload, list, CRUD, URL import, bulk ops ([43ac6df](https://github.com/Contentrain/studio/commit/43ac6df))
- Media agent tools — search, upload from URL, get metadata ([d400c42](https://github.com/Contentrain/studio/commit/d400c42))
- Asset manager UI — composable, card, uploader, detail, grid panel ([b6977ff](https://github.com/Contentrain/studio/commit/b6977ff))
- Content field media integration — picker and thumbnail preview ([2dcbc19](https://github.com/Contentrain/studio/commit/2dcbc19))
- Cdn media manifest, endpoint media serving, usage tracking ([0283d26](https://github.com/Contentrain/studio/commit/0283d26))
- Add media UI string dictionary entries (37 keys) ([328115c](https://github.com/Contentrain/studio/commit/328115c))
- Full-screen asset manager modal, fix card/detail preview ([328b2e0](https://github.com/Contentrain/studio/commit/328b2e0))
- Modern upload UX with XHR progress bar in drag-drop zone ([82c9234](https://github.com/Contentrain/studio/commit/82c9234))
- Integrate media assets into chat context pin system ([27fee9a](https://github.com/Contentrain/studio/commit/27fee9a))
- Add empty state illustrations, GitHub installation checks, and Pro CTAs ([d8f63aa](https://github.com/Contentrain/studio/commit/d8f63aa))
- Revise plan structure — usage-based pricing, unlimited workspaces ([8bce531](https://github.com/Contentrain/studio/commit/8bce531))
- Finalize pricing strategy — platform fee + AI credits + usage ([bf87437](https://github.com/Contentrain/studio/commit/bf87437))
- Add workspace and project deletion with type-to-confirm dialog ([3a0a0d3](https://github.com/Contentrain/studio/commit/3a0a0d3))
- Add server-side Content Brain cache with tree SHA delta detection ([f5f34a4](https://github.com/Contentrain/studio/commit/f5f34a4))
- Add brain/sync endpoint — unified content sync with delta detection ([7fca3c4](https://github.com/Contentrain/studio/commit/7fca3c4))
- Add Content Brain Web Worker with IndexedDB + FlexSearch ([72e8f9f](https://github.com/Contentrain/studio/commit/72e8f9f))
- Integrate brain cache into chat agent with brain_query and brain_search tools ([29bbbf3](https://github.com/Contentrain/studio/commit/29bbbf3))
- Content brain — agent integration, sync endpoint, client worker ([eea8673](https://github.com/Contentrain/studio/commit/eea8673))
- Add useContentBrain composable — Worker bridge + reactive state ([213741d](https://github.com/Contentrain/studio/commit/213741d))
- Convert useSnapshot + useModelContent to Brain adapters ([32c37c4](https://github.com/Contentrain/studio/commit/32c37c4))
- Rich content index + brain_analyze tool — full project awareness ([2172499](https://github.com/Contentrain/studio/commit/2172499))
- Plan-aware agent — CDN, media, API guidance per tier ([7617598](https://github.com/Contentrain/studio/commit/7617598))
- Rich plan-gated error messages + upgrade guidance rules ([c67c692](https://github.com/Contentrain/studio/commit/c67c692))
- Create content models for agent prompts, messages, and errors ([75d3e07](https://github.com/Contentrain/studio/commit/75d3e07))
- Server-side content string reader for agent/error dictionaries ([26dad43](https://github.com/Contentrain/studio/commit/26dad43))
- Add schema validation + project health dashboard ([0003729](https://github.com/Contentrain/studio/commit/0003729))
- Overhaul invitation system with EmailProvider, auto-accept, and resend ([f77b142](https://github.com/Contentrain/studio/commit/f77b142))
- Add branded magic-link and confirmation email templates ([916d3fa](https://github.com/Contentrain/studio/commit/916d3fa))
- Add forms & submissions — content-in via public form endpoints ([841e274](https://github.com/Contentrain/studio/commit/841e274))
- Add forms UI — submission list, detail modal, content panel tabs ([a5d5ce6](https://github.com/Contentrain/studio/commit/a5d5ce6))
- Add Conversation API + Webhook Outbound (Business+) ([1de3989](https://github.com/Contentrain/studio/commit/1de3989))
- Add UI for Conversation API keys + Webhooks in project settings ([f88aaf6](https://github.com/Contentrain/studio/commit/f88aaf6))
- **ui:** Add context pin, drag-drop, and edit modal to document content view ([1e341a5](https://github.com/Contentrain/studio/commit/1e341a5))
- **ui:** Expand command palette with 22 new commands and refactor into 3 files ([13354e7](https://github.com/Contentrain/studio/commit/13354e7))
- Add profile/account settings page with display name editing and account deletion ([df74c8e](https://github.com/Contentrain/studio/commit/df74c8e))
- Add workspace ownership transfer, avatar upload, and server-persisted theme ([bd41dd9](https://github.com/Contentrain/studio/commit/bd41dd9))
- **forms:** Add FormConfigSection UI and model PATCH endpoint ([52c1343](https://github.com/Contentrain/studio/commit/52c1343))
- Implement plan/package system with trial, Stripe billing, and pricing UI ([f559140](https://github.com/Contentrain/studio/commit/f559140))
- Implement billing system with free tier, Stripe trial, and subscription lifecycle ([45c698f](https://github.com/Contentrain/studio/commit/45c698f))
- **ui:** Add mobile responsive layout with sidebar drawer and tab navigation ([97a8118](https://github.com/Contentrain/studio/commit/97a8118))
- Add GDPR audit logging for destructive operations ([2bba363](https://github.com/Contentrain/studio/commit/2bba363))
- **content:** Add email-templates collection model with Contentrain SDK ([1a17c3e](https://github.com/Contentrain/studio/commit/1a17c3e))
- **webhooks:** Add DLQ email alert for permanently failed deliveries ([38790e7](https://github.com/Contentrain/studio/commit/38790e7))
- **branches:** Add branch health monitoring and auto-cleanup ([03bf3d5](https://github.com/Contentrain/studio/commit/03bf3d5))
- **infra:** Add Redis rate limiting and Docker deployment ([eda7b8a](https://github.com/Contentrain/studio/commit/eda7b8a))

### 🔥 Performance

- **cache:** Add model content caching — memory + IndexedDB ([ecf6867](https://github.com/Contentrain/studio/commit/ecf6867))

### 🩹 Fixes

- Color system to match old CMS tokens, remove surface, add optimizeDeps ([9a02ceb](https://github.com/Contentrain/studio/commit/9a02ceb))
- Replace red-* with danger-* in error messages ([abc97f8](https://github.com/Contentrain/studio/commit/abc97f8))
- **auth:** Fix dark mode panel colors and illustration layout ([1ac7f27](https://github.com/Contentrain/studio/commit/1ac7f27))
- **auth:** Illustration fills right panel, text pinned to bottom ([84d1cef](https://github.com/Contentrain/studio/commit/84d1cef))
- **auth:** Flex-col layout for right panel, illustration and text naturally stacked ([eaa7b67](https://github.com/Contentrain/studio/commit/eaa7b67))
- **auth:** Add min-h-0 to flex-1 illustration container to prevent overflow ([1aacc10](https://github.com/Contentrain/studio/commit/1aacc10))
- **auth:** Sticky h-screen right panel prevents scroll; add email icon to EmailButton ([0f28b29](https://github.com/Contentrain/studio/commit/0f28b29))
- **ui:** Email icon size and alignment — size-5 block to match provider SVGs ([de84f2c](https://github.com/Contentrain/studio/commit/de84f2c))
- **illustration:** Crop viewBox to actual content bounds (63 215 892 594) ([5b67716](https://github.com/Contentrain/studio/commit/5b67716))
- **illustration:** Tighter viewBox crop — y ends at 734 instead of 809 ([f2a71b2](https://github.com/Contentrain/studio/commit/f2a71b2))
- **a11y:** Global cursor-pointer, focus-visible ring, and explicit button type ([fa0832e](https://github.com/Contentrain/studio/commit/fa0832e))
- **i18n:** Replace all hardcoded strings with Contentrain dictionary keys ([6e75320](https://github.com/Contentrain/studio/commit/6e75320))
- **rls:** Resolve infinite recursion in workspace_members policies ([4320165](https://github.com/Contentrain/studio/commit/4320165))
- Resolve RLS recursion, hydration mismatch, and missing routes ([e8dc18c](https://github.com/Contentrain/studio/commit/e8dc18c))
- **ui:** Sidebar logo auto color — dark mode white, light mode colored ([b35ee7e](https://github.com/Contentrain/studio/commit/b35ee7e))
- **toast:** Resolve TypeScript 'possibly undefined' errors in ToastProvider ([e86a56c](https://github.com/Contentrain/studio/commit/e86a56c))
- **slug:** Use slugify library for proper Unicode transliteration ([dac6aca](https://github.com/Contentrain/studio/commit/dac6aca))
- Sidebar layout stability, mobile header, auth security, error pages ([9d8c0a3](https://github.com/Contentrain/studio/commit/9d8c0a3))
- **viewer:** Gray-matter parser, HTML strip, kind icons, document path fix ([5172b35](https://github.com/Contentrain/studio/commit/5172b35))
- **viewer:** Use kind instead of type in context panel, fix TS nullable errors ([f4945e3](https://github.com/Contentrain/studio/commit/f4945e3))
- **sidebar:** Remove workspace initial avatar — redundant with logo above ([91dd05b](https://github.com/Contentrain/studio/commit/91dd05b))
- Model content loads on page refresh with ?model= query param ([9d353e6](https://github.com/Contentrain/studio/commit/9d353e6))
- **i18n:** Replace hardcoded strings with dictionary keys + sanitize v-html ([f4354d1](https://github.com/Contentrain/studio/commit/f4354d1))
- **viewer:** Guard collection view against non-object entries ([b9042bc](https://github.com/Contentrain/studio/commit/b9042bc))
- **chat:** Correct model ID and robust error handling in SSE stream ([96975c6](https://github.com/Contentrain/studio/commit/96975c6))
- **chat:** Move push calls after send() to prevent SSE deadlock ([877ec89](https://github.com/Contentrain/studio/commit/877ec89))
- **chat:** Catch tool execution errors — return error to agent instead of crashing ([3f54f61](https://github.com/Contentrain/studio/commit/3f54f61))
- **chat:** Fix tool continuation — ensure input is object, fix message structure ([666ef60](https://github.com/Contentrain/studio/commit/666ef60))
- **chat:** Use sonnet 4.6 as default model for all tiers ([343dc17](https://github.com/Contentrain/studio/commit/343dc17))
- **chat:** Correct model ID — claude-sonnet-4-20250514 (not 4-6) ([281c5ec](https://github.com/Contentrain/studio/commit/281c5ec))
- **cache:** Invalidate model content cache after chat content changes ([6b59a31](https://github.com/Contentrain/studio/commit/6b59a31))
- **chat:** Remove product marketing from system prompt — concise, project-focused ([2b57ca9](https://github.com/Contentrain/studio/commit/2b57ca9))
- **chat:** Restore userEmail parameter — was incorrectly prefixed as unused ([9d75918](https://github.com/Contentrain/studio/commit/9d75918))
- **chat:** Derive project status from snapshot — show correct empty state for initialized projects ([9f374f1](https://github.com/Contentrain/studio/commit/9f374f1))
- **atoms:** Show selected value in FormSelect via SelectItemText, refine sm size ([fbd0db1](https://github.com/Contentrain/studio/commit/fbd0db1))
- **engine:** Normalize array content to object-map — prevent duplicate entries ([b5839c3](https://github.com/Contentrain/studio/commit/b5839c3))
- **chat:** Use correct cross icon for chip remove, improve button visibility ([1418306](https://github.com/Contentrain/studio/commit/1418306))
- **engine:** Merge-based save — prevent field loss and entry duplication ([ac9be1a](https://github.com/Contentrain/studio/commit/ac9be1a))
- **chat:** Improve context chip dark mode colors ([7ee33ba](https://github.com/Contentrain/studio/commit/7ee33ba))
- **types:** Resolve TypeScript errors in editor and model list components ([0eb8b1f](https://github.com/Contentrain/studio/commit/0eb8b1f))
- Resolve typecheck errors in content engine and serialization ([3899bde](https://github.com/Contentrain/studio/commit/3899bde))
- **ci:** Add packageManager field for pnpm/action-setup@v4 ([7bfaddb](https://github.com/Contentrain/studio/commit/7bfaddb))
- **ci:** Generate contentrain client before build ([f1be599](https://github.com/Contentrain/studio/commit/f1be599))
- **i18n:** Replace remaining hardcoded strings with dictionary keys ([c84d877](https://github.com/Contentrain/studio/commit/c84d877))
- **settings:** Replace free-text locale input with searchable ISO 639-1 picker ([280030f](https://github.com/Contentrain/studio/commit/280030f))
- Add vocabulary to ChatUIContext panelState type ([230aaa7](https://github.com/Contentrain/studio/commit/230aaa7))
- **settings:** Locale search matches by language name and code ([1bd7533](https://github.com/Contentrain/studio/commit/1bd7533))
- **settings:** Locale combobox now filters by name and code ([15aa054](https://github.com/Contentrain/studio/commit/15aa054))
- Resolve normalizeContentRoot import and bad icon names ([7ed36f6](https://github.com/Contentrain/studio/commit/7ed36f6))
- **ui:** Add consistent skeleton loading to all three panels ([336163e](https://github.com/Contentrain/studio/commit/336163e))
- **ui:** Show skeletons during initial page load, not just active fetch ([4264d95](https://github.com/Contentrain/studio/commit/4264d95))
- **ui:** Enforce Syne display font via HeadingText for all headings ([a1e2c02](https://github.com/Contentrain/studio/commit/a1e2c02))
- **ee:** Complete plan gating — limits, UI, hardcoded checks ([1841a87](https://github.com/Contentrain/studio/commit/1841a87))
- Code review fixes + documentation updates ([323440d](https://github.com/Contentrain/studio/commit/323440d))
- Replace non-existent annon--refresh with annon--arrow-swap ([e1cee5c](https://github.com/Contentrain/studio/commit/e1cee5c))
- Make config prop optional in ProjectSettingsModal ([cfb0f00](https://github.com/Contentrain/studio/commit/cfb0f00))
- **cdn:** Inline R2 provider to fix Nitro dynamic import issue ([2bc627c](https://github.com/Contentrain/studio/commit/2bc627c))
- **cdn:** Use static ESM import for S3 SDK (Nitro has no require) ([7231e8a](https://github.com/Contentrain/studio/commit/7231e8a))
- **cdn:** Add error detail to build record creation failure ([5b3cf2d](https://github.com/Contentrain/studio/commit/5b3cf2d))
- **cdn:** Add INSERT and UPDATE RLS policies for cdn_builds ([d6a6044](https://github.com/Contentrain/studio/commit/d6a6044))
- **cdn:** Reload CDN panel data on mount and project change ([1f85365](https://github.com/Contentrain/studio/commit/1f85365))
- **cdn:** Include all content in CDN build (defer status filtering to Phase 6) ([dd97377](https://github.com/Contentrain/studio/commit/dd97377))
- **cdn:** Resolve variable name collision in builder (modelIndex) ([949ac5b](https://github.com/Contentrain/studio/commit/949ac5b))
- **cdn:** Document builder handles content_path override and non-i18n flat files ([1e21711](https://github.com/Contentrain/studio/commit/1e21711))
- **cdn:** Security review fixes — rate limiting, role checks, HTML sanitization ([8400857](https://github.com/Contentrain/studio/commit/8400857))
- **security:** Critical review findings — auth, permissions, data integrity ([2fb0689](https://github.com/Contentrain/studio/commit/2fb0689))
- Path resolution, validation, and CDN enforcement ([a8ebcc0](https://github.com/Contentrain/studio/commit/a8ebcc0))
- **auth:** Add OAuth state token for CSRF protection ([ea66651](https://github.com/Contentrain/studio/commit/ea66651))
- Snapshot path resolution, member RLS, and invite state ([0e6344c](https://github.com/Contentrain/studio/commit/0e6344c))
- Deep review round 2 — branch scope, seat limits, history order, secrets ([bf128cf](https://github.com/Contentrain/studio/commit/bf128cf))
- **cdn:** Use named Marked import instead of marked.Marked ([c51ef70](https://github.com/Contentrain/studio/commit/c51ef70))
- **auth:** Make OAuth state validation truly optional for backward compat ([fb4c2a3](https://github.com/Contentrain/studio/commit/fb4c2a3))
- **auth:** Switch OAuth state to log-only mode for debugging ([821f3b2](https://github.com/Contentrain/studio/commit/821f3b2))
- **auth:** Don't crash on missing session secret, log warning instead ([6dc44c0](https://github.com/Contentrain/studio/commit/6dc44c0))
- **auth:** Handle corrupted session cookie gracefully ([422b80b](https://github.com/Contentrain/studio/commit/422b80b))
- **rls:** Rewrite workspace_members policies to eliminate recursion ([9faf67e](https://github.com/Contentrain/studio/commit/9faf67e))
- **rls:** Eliminate cross-table recursion in workspaces + workspace_members ([6d98cad](https://github.com/Contentrain/studio/commit/6d98cad))
- Connect sidebar Search button to command palette via keyboard event ([b954b03](https://github.com/Contentrain/studio/commit/b954b03))
- Use shared composable for command palette open state ([455de2d](https://github.com/Contentrain/studio/commit/455de2d))
- Command palette TS errors (keywords type, clearChat, implicit any) ([0f224b3](https://github.com/Contentrain/studio/commit/0f224b3))
- **cdn:** Load panel data when workspace becomes available ([6c2f1e7](https://github.com/Contentrain/studio/commit/6c2f1e7))
- **security:** Verify project belongs to workspace in member listing ([ae850b7](https://github.com/Contentrain/studio/commit/ae850b7))
- **security:** Enforce model-scoped access on reads and chat tools ([e211521](https://github.com/Contentrain/studio/commit/e211521))
- **security:** Enforce contentrain/ prefix on all branch operations ([4ebe46d](https://github.com/Contentrain/studio/commit/4ebe46d))
- **security:** Scope conversation routes to projectId ([ef53081](https://github.com/Contentrain/studio/commit/ef53081))
- Config and vocabulary use engine.mergeBranch for PR fallback ([d300171](https://github.com/Contentrain/studio/commit/d300171))
- Reload settings data on workspace slug change ([2d5e697](https://github.com/Contentrain/studio/commit/2d5e697))
- **a11y:** Add switch semantics and button labels ([105e8b9](https://github.com/Contentrain/studio/commit/105e8b9))
- **security:** Validate github installation binding ([c12ae98](https://github.com/Contentrain/studio/commit/c12ae98))
- Project visibility — member sees only assigned projects ([ef953f4](https://github.com/Contentrain/studio/commit/ef953f4))
- **auth:** Don't append state to Supabase OAuth URL ([f612efc](https://github.com/Contentrain/studio/commit/f612efc))
- **auth:** Remove explicit GitHub scopes, let Supabase handle defaults ([9f159c8](https://github.com/Contentrain/studio/commit/9f159c8))
- Make supabase reset migration safe on empty db ([b5e1cd8](https://github.com/Contentrain/studio/commit/b5e1cd8))
- Use manual URL in GitHub App provider to avoid Octokit path encoding ([3efafcc](https://github.com/Contentrain/studio/commit/3efafcc))
- Auth error display, document meta loading, and e2e browser setup ([c395689](https://github.com/Contentrain/studio/commit/c395689))
- Resolve SPA state leak on project/workspace navigation ([11d85f7](https://github.com/Contentrain/studio/commit/11d85f7))
- Improve SPA navigation watcher robustness ([cce9cf6](https://github.com/Contentrain/studio/commit/cce9cf6))
- **a11y:** Add aria-label to ContentModelList icon buttons ([fb444f1](https://github.com/Contentrain/studio/commit/fb444f1))
- Replace require() with static import for media provider in ESM ([ee79ce5](https://github.com/Contentrain/studio/commit/ee79ce5))
- Use non-empty value for Radix Select 'all types' filter option ([a2339fd](https://github.com/Contentrain/studio/commit/a2339fd))
- Initialize media type filter as 'all' to fix empty select display ([8266788](https://github.com/Contentrain/studio/commit/8266788))
- Add pro plan upgrade nudge to asset manager, fix select state ([5fece21](https://github.com/Contentrain/studio/commit/5fece21))
- Simplify sidebar asset panel, move detail to modal only ([812bc49](https://github.com/Contentrain/studio/commit/812bc49))
- Add preview proxy endpoint, fix expand icon, show image previews ([465dafc](https://github.com/Contentrain/studio/commit/465dafc))
- Replace inline SVG with annon--maximize icon for expand button ([8d78f20](https://github.com/Contentrain/studio/commit/8d78f20))
- Improve empty state copy for onboarding and standardize Asset Manager Pro CTA ([297007b](https://github.com/Contentrain/studio/commit/297007b))
- **a11y:** Focus rings, reduced motion, transition performance, and form attributes ([c8300d2](https://github.com/Contentrain/studio/commit/c8300d2))
- Replace hardcoded GitHub SVG with annon icon in settings fallback avatar ([5777bc6](https://github.com/Contentrain/studio/commit/5777bc6))
- Replace $t with useContent().t() in ConfirmDeleteDialog ([a9d71a8](https://github.com/Contentrain/studio/commit/a9d71a8))
- Brain cache — model name fallback, content summary race condition ([b02569c](https://github.com/Contentrain/studio/commit/b02569c))
- Worker URL path + diagnostic logging in brain composable ([dedad41](https://github.com/Contentrain/studio/commit/dedad41))
- Restore missing config assignment in brain sync ([e543c7c](https://github.com/Contentrain/studio/commit/e543c7c))
- Add in-memory content store for instant queryContent ([d0516ee](https://github.com/Contentrain/studio/commit/d0516ee))
- Use Vite ?worker import for proper Worker instantiation ([17b356d](https://github.com/Contentrain/studio/commit/17b356d))
- Restrict treeSha hash to .contentrain/ files only ([6513ffc](https://github.com/Contentrain/studio/commit/6513ffc))
- Agent should save external image URLs directly, not upload_media ([9d46ba8](https://github.com/Contentrain/studio/commit/9d46ba8))
- **test:** Stub agentPrompt global in agent-system-prompt test ([f0afef4](https://github.com/Contentrain/studio/commit/f0afef4))
- **test:** Adapt unit tests for i18n error messages and stub content-string globals ([ebe36b3](https://github.com/Contentrain/studio/commit/ebe36b3))
- Resolve all TypeScript errors across server and client ([a870e13](https://github.com/Contentrain/studio/commit/a870e13))
- Add sidebar health dot and missing dictionary keys ([7654ed0](https://github.com/Contentrain/studio/commit/7654ed0))
- **ui:** Redesign health dashboard and sidebar indicator ([025a189](https://github.com/Contentrain/studio/commit/025a189))
- Remove all type assertion hacks (as any) from UI components ([732fe36](https://github.com/Contentrain/studio/commit/732fe36))
- **security:** Harden forms endpoints — 9 critical issues resolved ([b31bbb1](https://github.com/Contentrain/studio/commit/b31bbb1))
- **security:** Resolve remaining forms audit findings ([650e09f](https://github.com/Contentrain/studio/commit/650e09f))
- Read content from contentrain SSOT branch + sync main→contentrain ([b27387a](https://github.com/Contentrain/studio/commit/b27387a))
- **security:** Enforce workspace-scoped limits and bulk operations ([aa2cad9](https://github.com/Contentrain/studio/commit/aa2cad9))
- Ensure contentrain branch exists before reading from it ([e945d02](https://github.com/Contentrain/studio/commit/e945d02))
- 3 scenario-audit bugs — migration safety, REST auto-merge, cache invalidation ([5a31d9c](https://github.com/Contentrain/studio/commit/5a31d9c))
- Resolve context.json merge conflict from MCP operations ([5470f2c](https://github.com/Contentrain/studio/commit/5470f2c))
- Resolve context.json merge conflict ([5c41c46](https://github.com/Contentrain/studio/commit/5c41c46))
- Resolve props before initialization error in ContentPanel ([2747102](https://github.com/Contentrain/studio/commit/2747102))
- Use correct annon--cross icon in SchemaWarningBanner ([571ff62](https://github.com/Contentrain/studio/commit/571ff62))
- Redirect to valid workspace when project/workspace not found ([da89c76](https://github.com/Contentrain/studio/commit/da89c76))
- **security:** Harden Conversation API + Webhook system — audit fixes ([176376c](https://github.com/Contentrain/studio/commit/176376c))
- **security:** Comprehensive audit — 30+ P1/P2 fixes across auth, RLS, API, media, CDN ([7ada60c](https://github.com/Contentrain/studio/commit/7ada60c))
- **security:** Close remaining audit gaps — project-member boundary, schema, CI, tests ([2241e9b](https://github.com/Contentrain/studio/commit/2241e9b))
- **icons:** Replace missing annon icon names with valid alternatives ([16347b9](https://github.com/Contentrain/studio/commit/16347b9))
- **ui:** Replace native confirm with Radix AlertDialog in content edit modal ([9408220](https://github.com/Contentrain/studio/commit/9408220))
- **ui:** Polish CommandPalette and finalize ProjectSettingsModal ([d8ca265](https://github.com/Contentrain/studio/commit/d8ca265))
- Update command palette icons and fix project context query ([330557b](https://github.com/Contentrain/studio/commit/330557b))
- **forms:** Complete forms system — auto-approve, plan limits, approve→entry ([02db65e](https://github.com/Contentrain/studio/commit/02db65e))
- **i18n:** Replace hardcoded toast strings in useMembers with t() keys ([6287fc1](https://github.com/Contentrain/studio/commit/6287fc1))
- **test:** Add getProjectById mock to db.test.ts ([5c7e746](https://github.com/Contentrain/studio/commit/5c7e746))
- **test:** Add getProfile mock to auth-routes integration test ([a28e7b2](https://github.com/Contentrain/studio/commit/a28e7b2))
- **ui:** Correct invalid annon icon names in FormConfigSection ([2c0e9bb](https://github.com/Contentrain/studio/commit/2c0e9bb))
- **test:** Update use-members test for t() localized toast messages ([bc81757](https://github.com/Contentrain/studio/commit/bc81757))
- **test:** Update RLS seed data plan from 'team' to 'pro' ([ba3de87](https://github.com/Contentrain/studio/commit/ba3de87))
- **billing:** Resolve 5 P1 issues from security review ([d247dee](https://github.com/Contentrain/studio/commit/d247dee))
- **billing:** Standardize plan data via Contentrain, remove hardcoded strings ([bed73ef](https://github.com/Contentrain/studio/commit/bed73ef))
- Atomic monthly limit checks to prevent race conditions ([b55bfb5](https://github.com/Contentrain/studio/commit/b55bfb5))
- Resolve typecheck errors in WorkspaceSwitcher and PlanSelectionModal ([7b48a46](https://github.com/Contentrain/studio/commit/7b48a46))
- Resolve all typecheck errors, test failures, and CI E2E boot crash ([461d1be](https://github.com/Contentrain/studio/commit/461d1be))
- **ci:** Use project playwright-core for browser install and add Supabase env to all E2E setups ([6715ec7](https://github.com/Contentrain/studio/commit/6715ec7))
- **security:** Resolve P1 authz bypass and hardening across 7 findings ([c177763](https://github.com/Contentrain/studio/commit/c177763))
- Sanitize all API error messages shown to users ([063a844](https://github.com/Contentrain/studio/commit/063a844))

### 💅 Refactors

- **auth:** Remove client-side Supabase, implement adapter-compliant auth ([1c37894](https://github.com/Contentrain/studio/commit/1c37894))
- **auth:** Provider-agnostic session layer with encrypted cookies ([d72272e](https://github.com/Contentrain/studio/commit/d72272e))
- **atoms:** Replace GhostButton with BaseButton — 4 variants, fixed alignment ([5298f30](https://github.com/Contentrain/studio/commit/5298f30))
- **ui:** Standardize all loading and empty states ([9684322](https://github.com/Contentrain/studio/commit/9684322))
- **toast:** Replace vue-sonner with Radix Vue Toast — zero extra deps ([0594526](https://github.com/Contentrain/studio/commit/0594526))
- **sidebar:** Merge logo into workspace switcher, clean layout ([c16d12e](https://github.com/Contentrain/studio/commit/c16d12e))
- **sidebar:** Restore STUDIO brand mark, compact project header ([ef0719d](https://github.com/Contentrain/studio/commit/ef0719d))
- **nav:** Merge workspace + project into unified navigation component ([346d6b0](https://github.com/Contentrain/studio/commit/346d6b0))
- **atoms:** Extract SectionLabel, IconButton, SidebarItem from repeated patterns ([5c6618d](https://github.com/Contentrain/studio/commit/5c6618d))
- **viewer:** Schema-aware field rendering — no hardcoded field names ([3afbd48](https://github.com/Contentrain/studio/commit/3afbd48))
- **viewer:** Extract content panel into 6 focused organisms ([c5626a8](https://github.com/Contentrain/studio/commit/c5626a8))
- **chat:** Optimize cost + reliability — 6 critical fixes ([7d478f8](https://github.com/Contentrain/studio/commit/7d478f8))
- **atoms:** Replace raw HTML with Radix Vue primitives + atoms ([3b331c6](https://github.com/Contentrain/studio/commit/3b331c6))
- **components:** Replace remaining raw inputs and buttons with atoms ([64de113](https://github.com/Contentrain/studio/commit/64de113))
- **chat:** Bounded task executor — state machine, context, intent, workflow-aware merge ([11b7f42](https://github.com/Contentrain/studio/commit/11b7f42))
- **vocabulary:** Move from inline overview to sidebar + dedicated panel ([b0f0682](https://github.com/Contentrain/studio/commit/b0f0682))
- **cdn:** Move CDN management from modal to sidebar + content panel ([74d0aad](https://github.com/Contentrain/studio/commit/74d0aad))
- **auth:** Move state management into AuthProvider ([e096548](https://github.com/Contentrain/studio/commit/e096548))
- Remove dead import.meta.server guards after SPA switch ([0dc2b25](https://github.com/Contentrain/studio/commit/0dc2b25))
- Use typed InjectionKey for ContentPanel provide/inject ([e9c08a1](https://github.com/Contentrain/studio/commit/e9c08a1))
- Remove old content endpoints and fallbacks — brain is single source ([8c5c630](https://github.com/Contentrain/studio/commit/8c5c630))
- Replace hardcoded agent prompts with content dictionary ([102661b](https://github.com/Contentrain/studio/commit/102661b))
- Replace hardcoded tool errors with error-messages dictionary ([ac8b246](https://github.com/Contentrain/studio/commit/ac8b246))
- Replace all server-side hardcoded strings with content dictionary SDK ([74da5e9](https://github.com/Contentrain/studio/commit/74da5e9))
- Migrate branch naming to cr/ prefix + SSOT content branch ([69c8bcb](https://github.com/Contentrain/studio/commit/69c8bcb))
- Harden provider and enterprise boundaries ([d7a671e](https://github.com/Contentrain/studio/commit/d7a671e))
- Split content-engine into focused modules ([5033584](https://github.com/Contentrain/studio/commit/5033584))
- **ui:** Extract workspace settings tabs into organism panels ([55dc2f2](https://github.com/Contentrain/studio/commit/55dc2f2))
- **ui:** Extract ContentVocabularyView and ContentStatsBar from ContentPanel ([3eda930](https://github.com/Contentrain/studio/commit/3eda930))
- **ui:** Redesign ProjectSettingsModal with visual hierarchy and CTA compliance ([e2c9137](https://github.com/Contentrain/studio/commit/e2c9137))
- Complete DatabaseProvider abstraction (Faz 0-3) ([ba75732](https://github.com/Contentrain/studio/commit/ba75732))
- Complete provider abstraction — zero Supabase leaks (Faz 4-5) ([cd27349](https://github.com/Contentrain/studio/commit/cd27349))
- **ee:** Align EE layer with starter/pro/enterprise plan structure ([f6a3758](https://github.com/Contentrain/studio/commit/f6a3758))
- Parametrize hardcoded plan prices and limits in dictionary strings ([24b02f6](https://github.com/Contentrain/studio/commit/24b02f6))
- **cache:** Migrate branch health cache to Redis with in-memory fallback ([0b10634](https://github.com/Contentrain/studio/commit/0b10634))

### 📖 Documentation

- Remove templates layer from component architecture ([78823c2](https://github.com/Contentrain/studio/commit/78823c2))
- Update review findings with resolved items and phase assignments ([405f0dc](https://github.com/Contentrain/studio/commit/405f0dc))
- Re-verify all review findings against current codebase ([a391419](https://github.com/Contentrain/studio/commit/a391419))
- Update phase status — Phase 3 completed, deferred items resolved ([bb73ed3](https://github.com/Contentrain/studio/commit/bb73ed3))
- Update CLAUDE.md — Phase 4 completed, roadmap added ([f35677c](https://github.com/Contentrain/studio/commit/f35677c))
- Align all documents — clean IDEAS, update roadmap, mark phases ([30a1016](https://github.com/Contentrain/studio/commit/30a1016))
- Update CLAUDE.md with git-architecture v2 references ([808a843](https://github.com/Contentrain/studio/commit/808a843))
- Update CLAUDE.md with current project state and verified deferred items ([d3fba9b](https://github.com/Contentrain/studio/commit/d3fba9b))
- Remove resolved profile items from deferred TODOs ([4255199](https://github.com/Contentrain/studio/commit/4255199))
- Add open source governance suite ([354b707](https://github.com/Contentrain/studio/commit/354b707))
- Rewrite readme and deployment guides ([7713d60](https://github.com/Contentrain/studio/commit/7713d60))

### 🏡 Chore

- Add eslint with stylistic, lint-staged, editorconfig, and agent skills ([18d041c](https://github.com/Contentrain/studio/commit/18d041c))
- Add eslint with stylistic, lint-staged, editorconfig, and agent skills ([1a6416b](https://github.com/Contentrain/studio/commit/1a6416b))
- Contentrain context after model creation ([a3e5dc2](https://github.com/Contentrain/studio/commit/a3e5dc2))
- Add tailwind 4 theme and contentrain SDK setup ([1e872aa](https://github.com/Contentrain/studio/commit/1e872aa))
- **contentrain:** Update context after auth-marketing model creation ([b3d71b1](https://github.com/Contentrain/studio/commit/b3d71b1))
- Gitignore fix ([083cf28](https://github.com/Contentrain/studio/commit/083cf28))
- Add webhook secret to .env.example ([ce38d56](https://github.com/Contentrain/studio/commit/ce38d56))
- Remove unused stub page and empty templates directory ([68345ed](https://github.com/Contentrain/studio/commit/68345ed))
- Add R2 CDN credentials to .env.example ([7789aaa](https://github.com/Contentrain/studio/commit/7789aaa))
- Update contentrain packages to latest ([dbd2003](https://github.com/Contentrain/studio/commit/dbd2003))
- Remove @contentrain/mcp from project deps (globally installed) ([434fc41](https://github.com/Contentrain/studio/commit/434fc41))
- Untrack generated contentrain client (already gitignored) ([7e874c4](https://github.com/Contentrain/studio/commit/7e874c4))
- Auto-commit contentrain model and content changes ([2b239ec](https://github.com/Contentrain/studio/commit/2b239ec))
- Auto-commit agent-messages model ([aecbe66](https://github.com/Contentrain/studio/commit/aecbe66))
- Auto-commit error-messages model ([e82504f](https://github.com/Contentrain/studio/commit/e82504f))
- Auto-commit agent-prompts content ([ae5029f](https://github.com/Contentrain/studio/commit/ae5029f))
- Auto-commit error-messages content ([a8ddb46](https://github.com/Contentrain/studio/commit/a8ddb46))
- Add vue-tsc as dev dependency ([c5205d0](https://github.com/Contentrain/studio/commit/c5205d0))
- Update context.json after starter kit additions ([50afe9e](https://github.com/Contentrain/studio/commit/50afe9e))
- **release:** Add automated container release flow ([8c3cc7f](https://github.com/Contentrain/studio/commit/8c3cc7f))
- **repo:** Stop tracking internal planning docs ([5b1d918](https://github.com/Contentrain/studio/commit/5b1d918))

### ✅ Tests

- Add vitest and nuxt test foundation ([4a8ab41](https://github.com/Contentrain/studio/commit/4a8ab41))
- Add second-wave production coverage ([3c4d675](https://github.com/Contentrain/studio/commit/3c4d675))
- Expand server coverage for production flows ([428a64d](https://github.com/Contentrain/studio/commit/428a64d))
- Cover chat and content editor flows ([4027056](https://github.com/Contentrain/studio/commit/4027056))
- Cover member and conversation routes ([a2c93b2](https://github.com/Contentrain/studio/commit/a2c93b2))
- Add http integration and rls harness ([3994324](https://github.com/Contentrain/studio/commit/3994324))
- Harden rls contracts and project visibility ([4f8effe](https://github.com/Contentrain/studio/commit/4f8effe))
- Harden ci and add browser coverage ([4f3147c](https://github.com/Contentrain/studio/commit/4f3147c))
- Harden production route coverage ([09e76d2](https://github.com/Contentrain/studio/commit/09e76d2))
- Media variant presets, MIME validation, and license feature gating ([e436049](https://github.com/Contentrain/studio/commit/e436049))
- Comprehensive media pipeline tests — 31 tests across 4 files ([b7fcad5](https://github.com/Contentrain/studio/commit/b7fcad5))
- Close remaining route coverage gaps ([1f8c761](https://github.com/Contentrain/studio/commit/1f8c761))
- Remove deprecated vitest env usage ([cefd337](https://github.com/Contentrain/studio/commit/cefd337))
- Align coverage with provider boundaries ([b792fd8](https://github.com/Contentrain/studio/commit/b792fd8))
- Add test sprint — project access, billing, encryption rotation, brain sync ACL ([e6a98cb](https://github.com/Contentrain/studio/commit/e6a98cb))

### 🎨 Styles

- **layout:** Fix workspace template line breaks and arbitrary width values ([6c41b96](https://github.com/Contentrain/studio/commit/6c41b96))
- Clean up AppSidebar template formatting ([95b0c28](https://github.com/Contentrain/studio/commit/95b0c28))

### 🤖 CI

- Remove e2e from CI pipeline — requires real Supabase + browser ([3d85fa4](https://github.com/Contentrain/studio/commit/3d85fa4))

### ❤️ Contributors

- Contentrain <ai@contentrain.io>
- ABB65 <bayhanbayramoglu@gmail.com>

