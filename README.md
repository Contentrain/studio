<div align="center">
  <img src="public/logo.svg" alt="Contentrain Studio" width="64" height="64" />
  <h1>Contentrain Studio</h1>
  <p><strong>Conversation-first CMS for teams who manage structured content over Git.</strong></p>
  <p>Connect a repository, define content models, edit through chat or UI, review changes through Git-native workflows, and ship through forms, media, CDN, and APIs.</p>

  <p>
    <a href="https://github.com/Contentrain/studio/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
    <a href="https://github.com/Contentrain/studio/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Contentrain/studio/ci.yml?branch=main&label=CI" alt="CI" /></a>
    <a href="https://github.com/Contentrain/studio/tree/main/ee"><img src="https://img.shields.io/badge/open--core-AGPL%20%2B%20EE-111827" alt="Open Core" /></a>
    <a href="https://github.com/Contentrain/studio/issues"><img src="https://img.shields.io/github/issues/Contentrain/studio" alt="Issues" /></a>
  </p>
</div>

---

## What Contentrain Studio Is

Contentrain Studio is an open-core, Git-backed content operations platform built with [Nuxt 4](https://nuxt.com/). Teams can self-host the AGPL core or use a managed Pro/Enterprise offering while keeping Git as the source of truth.

The product model is:

- your Git repository remains the source of truth
- content is schema-based and locale-aware
- users can operate through chat, forms, or structured UI
- changes become branches, commits, diffs, and merges
- delivery can happen through media, CDN, and API surfaces

This repository contains the AGPL core. Proprietary enterprise implementations live in [`ee/`](ee/) under a separate license. Managed Pro/Enterprise deployments can be operated on top of the same product model.

## Why It Exists

Traditional CMS products hide content workflows behind opaque databases and admin panels. Studio takes a different path:

- Git is the storage and audit layer
- schema validation protects structured content quality
- AI is bounded by tools and permissions, not used as an uncontrolled shell
- workspaces and projects map cleanly to team and repository boundaries
- self-hosting remains a supported trust path, and managed operation is also available

## Relationship to Contentrain AI

Studio shares the same `.contentrain/` contract with the MIT package surface in the `contentrain-ai` repository. Developers usually enter the ecosystem through local-first package workflows, then move into Studio when review, roles, and delivery become operational needs.

| AI surface | Primary job | Studio bridge | Docs |
| --- | --- | --- | --- |
| `@contentrain/mcp` | Deterministic local content operations and normalize | Studio applies the same content contract through authenticated review and delivery workflows | [MCP Tools](https://ai.contentrain.io/packages/mcp) |
| `contentrain` CLI | `init`, `serve`, `generate`, `diff`, `validate` | Studio takes over when teams need a web surface, project management, and approval | [CLI](https://ai.contentrain.io/packages/cli) |
| `@contentrain/rules` | Shared quality and schema standards | Studio chat, review, and validation should stay aligned with the same rules | [Rules & Skills](https://ai.contentrain.io/packages/rules) |
| `@contentrain/skills` | Agent playbooks and workflow hints | Studio mirrors these workflows in onboarding, chat-led operations, and handoffs | [Rules & Skills](https://ai.contentrain.io/packages/rules) |
| `@contentrain/query` | Local typed consumption and CDN client transport | Studio extends the same content into remote delivery and API-key-based CDN access | [Query SDK](https://ai.contentrain.io/packages/sdk) |

Typical path:

`contentrain init` → normalize hardcoded content → review in Studio → invite teammates → deliver through CDN/API when needed

## Product Surface

### Core Platform

- Workspace and project management
- GitHub App-based repository connection
- Structured content models:
  - collection
  - singleton
  - document
  - dictionary
- Multi-locale content workflows
- Chat-driven content operations
- Content validation and health reporting
- Branch, diff, merge, and review workflows
- Team and role management

### Delivery and Operations

- Media library and upload pipeline
- Forms and submission review
- CDN build and delivery surfaces
- Webhook and conversation API bridges
- Billing, plan limits, and self-host deployment fallbacks

### Open Core Model

- **Core (`app/`, `server/`, `supabase/`, tests)**: AGPL-3.0
- **Enterprise (`ee/`)**: proprietary implementations for premium operational surfaces

See:

- [Enterprise README](ee/README.md)
- [License](LICENSE)
- [Security Policy](SECURITY.md)

## Architecture at a Glance

```text
User → Workspace → Project → Repository
```

- **Workspace**: billing, team, installation, and policy boundary
- **Project**: connected Git repository inside a workspace
- **Content Engine**: validation, serialization, branching, commit, merge
- **Conversation Engine**: AI loop with tool execution and permission enforcement
- **Provider Layer**: auth, database, git, AI, email, billing, CDN, media

### Stack

| Layer | Current implementation |
| --- | --- |
| Framework | Nuxt 4 |
| UI | Radix Vue + Tailwind CSS 4 |
| Auth | Provider interface, currently Supabase Auth |
| Database | Provider interface, currently Supabase PostgreSQL + RLS |
| Git | Provider interface, currently GitHub App |
| AI | Provider interface, currently Anthropic |
| Email | Provider interface, currently Resend |
| Billing | Plugin registry, default Polar (MoR), Stripe fallback |
| CDN / Media | Enterprise bridge-backed implementations (ee/-resident) |

The architectural rule is strict: application code talks to provider interfaces and shared utilities, not vendor SDKs directly.

## Editions

Studio ships in two editions, distinguished by whether the `ee/` directory is loaded at runtime. Edition is **orthogonal to plan tier** — a managed Enterprise customer and a self-hosted Community user share the same tier vocabulary but different code paths.

| | Community Edition | Enterprise Edition |
|---|---|---|
| License | AGPL-3.0 + `LICENSE-EXCEPTIONS` | AGPL core + `ee/LICENSE` (proprietary) |
| `ee/` directory | Absent or not loaded | Present and loaded |
| Billing | Off | Polar / Stripe / flat-fee / off |
| Plan tier | Fixed `community` (unlimited) | `free` / `starter` / `pro` / `enterprise` |
| Typical scenarios | AGPL self-host, forks, hosting resellers, local eval | Managed SaaS (contentrain.io), on-premise enterprise, managed dedicated, OEM, white-label |

See [docs/EDITIONS.md](docs/EDITIONS.md) for the full feature matrix.

## Deployment Profiles

Studio auto-detects a deployment profile at boot from (a) `ee/` presence and (b) configured payment plugins. `NUXT_DEPLOYMENT_PROFILE` overrides.

| Profile | Edition | Billing mode | Plan source |
|---|---|---|---|
| `managed` | ee required | polar / stripe | subscription |
| `dedicated` | ee required | flat or subscription | operator or subscription |
| `on-premise` | ee required | off | operator-set (default `enterprise`) |
| `community` | agpl only | off | fixed `community` |

See [docs/DEPLOYMENT_PROFILES.md](docs/DEPLOYMENT_PROFILES.md) for the 12-scenario matrix and per-profile env checklist.

## Plans and Licensing

Current runtime plans: `community` (auto-assigned in Community Edition, not purchasable) / `free` / `starter` / `pro` / `enterprise`.

Plan-differentiated capability examples:

- AI usage, Studio-hosted key, BYOA (Pro+)
- CDN delivery, preview branches, custom domain
- Media upload / library / custom variants
- Review workflow and advanced project roles (Reviewer, Viewer)
- Conversation API and outbound webhooks
- Enterprise-only SSO, white-label, custom MCP domain

The source of truth lives in [`shared/utils/license.ts`](shared/utils/license.ts) and [`.contentrain/content/system/plan-features/`](.contentrain/content/system/plan-features/). Feature gating runs through `hasFeature(plan, key)` with the current edition applied.

For license inquiries, see [docs/LICENSING.md](docs/LICENSING.md) and contact `licensing@contentrain.io`.

## Repository Structure

```text
studio/
├─ app/                 # Frontend pages, layouts, components, composables
├─ server/              # Nitro routes, middleware, providers, utilities
├─ supabase/            # Migrations, local Supabase config, RLS policies
├─ ee/                  # Proprietary enterprise implementations
├─ tests/               # Unit, integration, Nuxt, RLS, and E2E suites
├─ .contentrain/        # Content models and generated query client
└─ docs/                # Release-facing deployment and self-hosting docs
```

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 10+
- Git
- [Supabase CLI](https://supabase.com/docs/guides/cli) for local database/auth flows

### Local Development

```bash
git clone https://github.com/Contentrain/studio.git
cd studio
pnpm install
cp .env.example .env
pnpm db:start
pnpm db:migrate
npx contentrain generate
pnpm dev
```

Local app URL:

- `http://localhost:3000`

## Documentation

Release-facing setup and deployment docs:

- [Environment Reference](.env.example)
- [Editions](docs/EDITIONS.md) — Community vs Enterprise feature matrix
- [Deployment Profiles](docs/DEPLOYMENT_PROFILES.md) — 12 scenarios × profile × env
- [Licensing Overview](docs/LICENSING.md) — SKU × license type × scenario
- [Self-Hosting Guide](docs/SELF_HOSTING.md)
- [Docker Guide](docs/DOCKER.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Payment Providers](docs/PAYMENT_PROVIDERS.md)
- [Releasing Guide](docs/RELEASING.md)
- [Repository Hygiene](docs/REPOSITORY-HYGIENE.md)
- [Contributing Guide](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Enterprise Edition README](ee/README.md)

## Testing

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:nuxt
pnpm test:rls
pnpm test:e2e
pnpm test:ci
pnpm build
```

## Security and Responsible Disclosure

Do not open public issues for vulnerabilities.

Report security issues privately:

- [security@contentrain.io](mailto:security@contentrain.io)

See [SECURITY.md](SECURITY.md) for scope, timelines, and disclosure guidance.

## Branch Model

Studio is trunk-based. `main` is the single integration branch and the target for every PR. Staging is a Railway deployment environment fed from `main`, not a separate Git branch.

- **Contributors**: open PRs against `main` (GitHub's default base, no extra step needed).
- **Self-hosters**: deploy from tagged releases (`v0.1.0`, `v0.2.0`, …). Tags are the stability contract; `main` HEAD can include not-yet-released changes.
- **Releases**: maintainers cut a version tag on `main` → production deploy. See [docs/RELEASING.md](docs/RELEASING.md).

## Contributing

Community contributions are welcome for the AGPL core.

Before opening a PR, read:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)

## License

- Core: [GNU Affero General Public License v3.0](LICENSE) + [`LICENSE-EXCEPTIONS`](LICENSE-EXCEPTIONS) (AGPL §7(c) attribution + §7(e) no-trademark)
- Enterprise directory: [Proprietary license](ee/LICENSE) — Managed Use, On-Premises Deployment, Evaluation, OEM, and White-Label grants
- Dual-license index: [`NOTICE`](NOTICE)

If you run a modified version of the AGPL core as a network service, you must make the Corresponding Source available to interacting users — the built-in `/about` page satisfies this obligation by linking to the upstream repository. See [docs/LICENSING.md](docs/LICENSING.md) for the full mapping of SKU × license type × supported scenario.

---

<div align="center">
  <p>Built with Nuxt, Vue, Radix Vue, and Git-native content workflows.</p>
  <p>Copyright 2026 Contentrain, LLC.</p>
</div>
