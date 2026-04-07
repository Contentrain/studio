# Contentrain Studio — Roadmap

> Last updated: 2026-04-07 | Current release: v0.1.0-beta.4

This roadmap reflects our current priorities. Items may shift based on user feedback and production learnings.

---

## Shipped (v0.1.0-beta)

Core platform is feature-complete for beta:

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
| Billing | Stripe integration, 4-tier flat-rate plans (Free / Starter / Pro / Enterprise) |
| Content Brain | IndexedDB offline cache, semantic search, full-text index, delta sync |
| Audit Logs | Application + database-level audit trail, 90-day retention |
| Self-Hosting | Docker Compose deployment, 3-stage build |

---

## Now — Stabilization (v0.1.x)

Focus: production readiness, monitoring, critical fixes.

- [ ] **Sentry integration** — Client + server error monitoring and alerting
- [x] **Open-source docs** — Self-hosting guide, contributing guide, security policy, code of conduct, Docker/deployment docs
- [ ] **User testing & feedback loop** — Structured beta testing with real teams
- [x] **Monthly limit atomicity** — Atomic RPC functions for workspace members, CDN keys, and storage quota (migration 019)
- [x] **GDPR audit for deletions** — Bulk delete audit logging, 4 missing audit registry entries (CDN key, conversation key, webhook, AI key)

---

## Next — Post-Launch Polish (v0.2.x)

Focus: UX polish, operational resilience, mobile support.

- [ ] **Usage-based overage billing** — Stripe metered billing for AI messages, CDN bandwidth, storage, form submissions. Currently hard-blocks at plan limit; needs soft-limit + overage invoicing.
- [ ] **Mobile responsive shell** — Hamburger menu + slide-over drawer for mobile viewports
- [ ] **Branch health warnings** — 80+ branch threshold alert, auto-cleanup of merged cr/* branches
- [ ] **Brain cache webhook invalidation** — GitHub push webhook triggers cache invalidation (currently TTL-only)
- [ ] **Multi-locale tools** — Bulk translation helpers, locale coverage dashboard

---

## Future

No timeline commitment. Prioritized by user demand.

- [ ] **Plain PostgreSQL provider** — DatabaseProvider implementation for self-hosted deployments without Supabase dependency. Interface exists (`server/providers/database.ts`), needs `pg-db/` implementation.
- [ ] **OpenAI / Gemini AI providers** — Alternative AI backends (GPT-4o, Gemini) via existing AIProvider interface (`server/providers/ai.ts`). Currently only Anthropic implemented.
- [ ] **Voice input** — Browser Speech-to-Text API, microphone button in chat panel. Speech-to-text transcription sent as regular chat message.
- [ ] **Service Worker & PWA** — Background sync, offline write queue, push notifications, installable app experience. *Current state:* Content Brain Worker already provides offline read via IndexedDB + FlexSearch. Service Worker would add offline writes and push notifications.
- [ ] **GitLab / Bitbucket providers** — GitProvider implementations for GitLab and Bitbucket Git APIs. Interface exists (`server/providers/git.ts`), currently only GitHub implemented.
- [ ] **Real-time collaboration** — Presence indicators, live cursors in content editor
- [ ] **Plugin system** — User-installable extensions for custom field types, validators, integrations
- [ ] **Advanced search** — Cross-project content search, saved filters, search history

---

## Enterprise Edition (ee/)

Proprietary features under `ee/` directory. Core (AGPL) is a fully functional product without these.

- [ ] **Multi-repo governance** — Cross-repository content management and standards enforcement
- [ ] **Advanced roles** — Reviewer, Viewer, model-specific access control (specificModels + allowedModels)
- [ ] **SSO** — SAML 2.0 and OIDC federation
- [ ] **Premium connectors** — Canva, Figma, Recraft, Notion, Google Drive integrations
- [ ] **Approval chains** — Multi-step review workflows with scheduled publish
- [ ] **White-label branding** — Custom domain, logo, color overrides for Studio instances

---

## How We Prioritize

1. **User feedback** — Reported bugs and feature requests from real usage
2. **Stability** — Production reliability before new features
3. **Core before EE** — AGPL core must be fully functional standalone
4. **Simplicity** — Solve real problems, avoid speculative features
