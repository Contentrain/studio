# Contentrain Studio — Roadmap

> Last updated: 2026-10-09 | Current release: v0.4.8 (see [GitHub Releases](https://github.com/Contentrain/studio/releases) and [CHANGELOG.md](CHANGELOG.md) for what each release shipped)

This roadmap reflects our current priorities. Items may shift based on user feedback and production learnings.

See [docs/EDITIONS.md](docs/EDITIONS.md) for the Community vs Enterprise feature matrix and [docs/DEPLOYMENT_PROFILES.md](docs/DEPLOYMENT_PROFILES.md) for the 12 supported deployment scenarios.

---

## Shipped (through v0.4.x)

Core platform:

| Area | What |
|------|------|
| Auth & Teams | GitHub OAuth (owner), Google/Magic Link (members), workspace hierarchy, 4-tier roles |
| Content Management | Chat-first AI agent + inline editing, 4 content kinds, 27 field types |
| Git Workflow | Two-step merge (cr/* -> contentrain -> main), branch review, diff viewer |
| CDN Delivery | Event-driven build pipeline, public REST API, ETag caching |
| Media Management | Upload, optimize, variant generation, blurhash, asset manager |
| Forms & Submissions | Public form API, captcha, rate limiting, approve/reject flow |
| Conversation API | External AI content operations via API key auth |
| Webhooks | Outbound event delivery, HMAC-SHA256 signing, retry with backoff |
| Billing | Payment plugin registry: Polar by default, Stripe as an opt-in plugin ([docs/PAYMENT_PROVIDERS.md](docs/PAYMENT_PROVIDERS.md)); 4-tier plans (Free / Starter / Pro / Enterprise) |
| Approvals & Scheduling | Approval gates for branches and releases (`server/utils/approval-gate.ts`, `branch-approval.ts`, `release-approval.ts`), scheduled publication (`server/utils/schedule-registry.ts`) |
| Content Brain | IndexedDB offline cache, semantic search, full-text index, delta sync |
| Audit Logs | Application + database-level audit trail, 90-day retention |
| Overage Billing | Metered overage for AI credits, API credits, MCP Cloud calls and form submissions, with a usage dashboard. CDN bandwidth and media storage are hard limits; their overage is not sold (`overageBillable: false` in `shared/utils/usage-meters.ts`) |
| CLI Integration | Auth (OAuth + token refresh), activity feed, usage API for Studio CLI |
| Self-Hosting | Docker Compose deployment, 3-stage build; plain PostgreSQL 14+ provider (`server/providers/postgres-db/`) as an alternative to Supabase |

---

## Now — Stabilization + MCP ecosystem alignment

Focus: production readiness, monitoring, critical fixes, alignment with
`@contentrain/mcp` ecosystem.

- [ ] **Sentry integration** — Client + server error monitoring and alerting
- [x] **Open-source docs** — Self-hosting guide, contributing guide, security policy, code of conduct, Docker/deployment docs
- [ ] **User testing & feedback loop** — Structured beta testing with real teams
- [x] **Monthly limit atomicity** — Atomic RPC functions for workspace members, CDN keys, and storage quota (migration 019)
- [x] **GDPR audit for deletions** — Bulk delete audit logging, 4 missing audit registry entries (CDN key, conversation key, webhook, AI key)
- [x] **MCP integration** — Content engine (save/delete/model CRUD + validation + canonical serialization) delegates to `@contentrain/mcp/core/ops`. `GitProvider` wraps MCP's `GitHubProvider`; Studio keeps brain-cache, branch lifecycle, and Studio-specific extensions (framework detection, PR helpers, tree listing). Faz S1–S5 in `.internal/refactor/02-studio-handoff.md`.
- [x] **Comments v1** — Studio-stored comment threads on entries: public read/submit API for any site (the migration path's `<cr-component type="comments">`), moderation tab + moderator replies, agent tools, WordPress import of `contentrain-comments@1` exports with zero record/parent loss. `docs/COMMENTS.md`.
- [x] **MCP Cloud endpoint (`api.mcp_cloud`)** — Hosted HTTP MCP endpoint for external AI agents (Cursor, Claude Desktop, custom drivers). Shipped on `@contentrain/mcp@1.4.0`'s `resolveProvider` multi-tenant entry point (monthly call quotas and the per-call overage price come from the `api.mcp_calls_per_month` row of `.contentrain/content/system/plan-features/data.json`). Architecture: internal loopback MCP HTTP server + Nuxt proxy route that handles auth / plan gate / rate limit / atomic quota / brain-cache invalidation. Workspace Settings → MCP Cloud tab for key management. Faz S6.

---

## Next — Post-Launch Polish

Focus: UX polish, operational resilience, mobile support.

- [x] **Usage-based overage billing** — metered overage with overage settings and usage dashboard (first shipped v0.1.0-beta.6 on Stripe; Polar is the default provider today, and CDN bandwidth / media storage remain hard limits)
- [x] **Mobile responsive shell** — Hamburger menu + slide-over drawer for mobile viewports (shipped v0.1.0-beta.1)
- [ ] **Branch health warnings** — 80+ branch threshold alert, auto-cleanup of merged cr/* branches
- [ ] **Brain cache webhook invalidation** — GitHub push webhook triggers cache invalidation (currently TTL-only)
- [ ] **Multi-locale tools** — Bulk translation helpers, locale coverage dashboard

---

## Future

No timeline commitment. Prioritized by user demand.

- [ ] **OpenAI / Gemini AI providers** — Alternative AI backends (GPT-4o, Gemini) via existing AIProvider interface (`server/providers/ai.ts`). Currently only Anthropic implemented.
- [ ] **Voice input** — Browser Speech-to-Text API, microphone button in chat panel. Speech-to-text transcription sent as regular chat message.
- [ ] **Service Worker & PWA** — Background sync, offline write queue, push notifications, installable app experience. *Current state:* Content Brain Worker already provides offline read via IndexedDB + FlexSearch. Service Worker would add offline writes and push notifications.
- [ ] **GitLab / Bitbucket providers** — GitLab support is mostly there via `@contentrain/mcp/providers/gitlab` (wire-up exists in `createStudioGitProvider`); remaining work: installation-level operations (repo listing, template creation) parity with the GitHub path. Bitbucket + Azure DevOps pending upstream MCP support.
- [ ] **Real-time collaboration** — Presence indicators, live cursors in content editor
- [ ] **Plugin system** — User-installable extensions for custom field types, validators, integrations
- [ ] **Advanced search** — Cross-project content search, saved filters, search history

---

## Enterprise Edition (ee/)

Proprietary features under `ee/` directory. Community Edition (AGPL core without `ee/`) is a fully functional product — see [docs/EDITIONS.md](docs/EDITIONS.md) for the full feature matrix.

### Shipped in ee/

| Feature | Matrix key | Plans |
|---|---|---|
| BYOA API key management | `ai.byoa` | Pro, Enterprise |
| Conversation API + keys | `api.conversation`, `api.conversation_keys` | Pro, Enterprise |
| Outbound webhooks | `api.webhooks_outbound`, `api.webhooks` | Starter+ |
| CDN content delivery + metering | `cdn.delivery`, `cdn.metering` | Starter+ |
| Media upload / library / variants | `media.upload`, `media.library`, `media.custom_variants` | Starter+ (custom variants Pro+) |
| Reviewer / Viewer project roles | `roles.reviewer`, `roles.viewer` | Starter+ |
| Model-specific access | `roles.specific_models` | Pro, Enterprise |

### Advertised, implementation pending (`roadmap: true` in `plan-features`)

These rows exist in the plan matrix as marketing and carry `roadmap: true`. UI surfaces should render a "Coming Soon" chip. Enforcement call sites land when implementation does.

- [ ] **SSO (SAML 2.0)** — `sso.saml` — federated login for enterprise workspaces
- [ ] **SSO (OIDC)** — `sso.oidc` — same, OIDC flavor
- [ ] **White-label branding** — `branding.white_label` — custom domain, logo, color overrides
- [ ] **CDN custom domain** — `cdn.custom_domain` — bring-your-own domain for CDN delivery
- [ ] **CDN preview branches** — `cdn.preview_branch` — per-branch CDN endpoints for previews
- [ ] **MCP Cloud custom domain** — `api.mcp_cloud_custom_domain`
- [ ] **MCP Cloud SSO** — `api.mcp_cloud_sso`

### Beyond roadmap features — exploratory

- [ ] **Multi-repo governance** — Cross-repository content management and standards enforcement
- [ ] **Premium connectors** — Canva, Figma, Recraft, Notion, Google Drive integrations
- [ ] **Form spam filter (server-side)** — `forms.spam_filter` — beyond Turnstile captcha, a real heuristic/ML filter
- [ ] **Media variants per-field enforcement** — `media.variants_per_field` limit check in variant creation path

### License model evaluation

- [ ] **AGPL → BSL migration study** — evaluate whether to move core from AGPL-3.0 to a Business Source License (Change Date = +4 years). Context: AGPL §7 cannot enforce commercial SaaS resale restrictions; only trademark (via `LICENSE-EXCEPTIONS` §7(e)) is enforceable today. BSL would add real resale protection at the cost of OSI "open source" designation. Decision criteria: market signals of reseller arbitrage on the core; willingness of the community to accept BSL terms.

---

## How We Prioritize

1. **User feedback** — Reported bugs and feature requests from real usage
2. **Stability** — Production reliability before new features
3. **Core before EE** — AGPL core must be fully functional standalone
4. **Simplicity** — Solve real problems, avoid speculative features
