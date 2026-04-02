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

Contentrain Studio is a self-hosted, Git-backed content operations platform built with [Nuxt 4](https://nuxt.com/). It is designed for teams who want structured content, reviewable Git workflows, and an AI operator without giving up repository ownership.

The product model is:

- your Git repository remains the source of truth
- content is schema-based and locale-aware
- users can operate through chat, forms, or structured UI
- changes become branches, commits, diffs, and merges
- delivery can happen through media, CDN, and API surfaces

This repository contains the AGPL core. Proprietary enterprise implementations live in [`ee/`](ee/) under a separate license.

## Why It Exists

Traditional CMS products hide content workflows behind opaque databases and admin panels. Studio takes a different path:

- Git is the storage and audit layer
- schema validation protects structured content quality
- AI is bounded by tools and permissions, not used as an uncontrolled shell
- workspaces and projects map cleanly to team and repository boundaries
- self-hosting remains the first-class deployment model

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
| Billing | Provider interface, currently Stripe |
| CDN / Media | Enterprise bridge-backed implementations |

The architectural rule is strict: application code talks to provider interfaces and shared utilities, not vendor SDKs directly.

## Plans and Licensing

Studio uses an open-core model and a plan/limit system.

Current runtime plans:

- `free`
- `starter`
- `pro`
- `enterprise`

Examples of plan-differentiated capability:

- AI usage and BYOA
- CDN delivery and preview branches
- Media upload and custom variants
- Review workflow and advanced roles
- Conversation API and outbound webhooks
- Enterprise-only SSO, white-label, and custom domain surfaces

The source of truth for limits and feature checks lives in [`shared/utils/license.ts`](shared/utils/license.ts).

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
- [Docker Guide](docs/DOCKER.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Releasing Guide](docs/RELEASING.md)
- [Repository Hygiene](docs/REPOSITORY-HYGIENE.md)
- [Self-Hosting Guide](docs/SELF_HOSTING.md)
- [Contributing Guide](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

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

## Contributing

Community contributions are welcome for the AGPL core.

Before opening a PR, read:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)

## License

- Core: [GNU Affero General Public License v3.0](LICENSE)
- Enterprise directory: [Proprietary license](ee/LICENSE)

If you run a modified version of the AGPL core as a network service, you must provide the corresponding source code to users of that service, consistent with AGPL obligations.

---

<div align="center">
  <p>Built with Nuxt, Vue, Radix Vue, and Git-native content workflows.</p>
  <p>Copyright 2026 Contentrain, LLC.</p>
</div>
