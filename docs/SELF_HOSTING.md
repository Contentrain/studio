# Self-Hosting Guide

Contentrain Studio supports self-hosting of the AGPL core under two shapes: **Community Edition** (AGPL only, no `ee/` code) and **Enterprise Edition** on-premise (AGPL core + `ee/` under a commercial license). This guide covers the self-managed deployment path; managed Pro/Enterprise operation on `contentrain.io` is a separate offering.

Two concepts drive the behavior:

- **Edition** — whether the `ee/` directory is present and loaded at runtime. See [EDITIONS.md](EDITIONS.md) for the Community vs Enterprise feature matrix.
- **Deployment profile** — a named preset (`managed` / `dedicated` / `on-premise` / `community`) that configures billing mode and plan source coherently. See [DEPLOYMENT_PROFILES.md](DEPLOYMENT_PROFILES.md) for the 12 supported scenarios.

Self-hosting typically means one of two profiles:

- `community` — AGPL only, no managed billing, every workspace at the fixed `community` tier with unlimited usage on your infrastructure.
- `on-premise` — AGPL core + licensed `ee/`, operator-set plan tier (default `enterprise`), no managed billing flow.

## Core Principles

- the app is stateless
- Git repositories remain external and authoritative
- auth/data are supplied through provider-backed integrations
- enterprise features degrade safely when `ee/` functionality or external services are absent

## What to Deploy

Always deploy a **tagged release** container image, not `main` HEAD. Tags are the supported stability contract; `main` is stable-at-HEAD for CI purposes but may carry not-yet-released changes at any moment.

```bash
docker pull ghcr.io/contentrain/studio:v0.1.0-beta.7
```

See [DOCKER.md](DOCKER.md) for the full image-tag policy and [RELEASING.md](RELEASING.md) for the release cadence. Pinning to an exact `vX.Y.Z` tag makes upgrades explicit; avoid `:latest` in production.

## What You Need

### Required

- A reachable public app URL
- One auth/database **provider pair** (see below): a Supabase-compatible deployment, **or** any plain PostgreSQL 14+ instance
- GitHub App credentials for repository operations
- A strong `NUXT_SESSION_SECRET`

### Optional

- Anthropic API key
- Resend sender configuration (required for the managed pair — magic link + invites)
- Stripe billing
- R2 object storage
- Redis
- Cloudflare Turnstile (`NUXT_TURNSTILE_SECRET_KEY`, `NUXT_PUBLIC_TURNSTILE_SITE_KEY`) — only when a model's form or comments config selects `captcha: turnstile`

## Choosing a Provider Pair

Auth and database providers ship as **matched pairs** — mixing them is rejected at boot:

| Pair | Env | Auth | Database |
|---|---|---|---|
| `supabase + supabase` (default) | `NUXT_AUTH_PROVIDER=supabase`, `NUXT_DATABASE_PROVIDER=supabase` | Supabase Auth (GoTrue) | Supabase PostgreSQL |
| `managed + postgres` | `NUXT_AUTH_PROVIDER=managed`, `NUXT_DATABASE_PROVIDER=postgres` | Built-in: JWT (HS256) + refresh rotation, OAuth via GitHub/Google login apps, magic link via Resend | Any plain PostgreSQL 14+ |

**The managed + postgres pair removes the Supabase dependency entirely** — bring any PostgreSQL (RDS, Railway, a container, your own cluster). It requires:

- `NUXT_POSTGRES_URL` — the connection string
- `NUXT_AUTH_JWT_SECRET` — ≥32 chars, signs access/refresh tokens
- `NUXT_RESEND_API_KEY` — magic-link + invite emails
- `NUXT_OAUTH_GITHUB_CLIENT_ID` / `NUXT_OAUTH_GITHUB_CLIENT_SECRET` — a GitHub **OAuth App** for login (one callback per app: `https://<your-domain>/api/auth/oauth/github`); Google optional
- `NUXT_SESSION_PASSWORD` — ≥32 chars for the OAuth module session endpoint (dev auto-generates it; deployed builds must set it)

Migrations run through the bundled plain-PG runner (one lineage: `postgres/migrations/000_auth_shim.sql` + `supabase/migrations/*.sql`):

```bash
pnpm db:migrate:pg          # applies the lineage (NUXT_POSTGRES_URL or --url)
pnpm db:verify:pg           # verifies schema, trigger chain, and RLS isolation
```

Both commands are idempotent — re-runs skip applied files via `public.schema_migrations`. The Supabase pair keeps using the Supabase CLI (`pnpm db:migrate`), which reads the same `supabase/migrations/` files.

## Recommended Topology

```text
User
  ↓
Reverse Proxy / TLS
  ↓
Contentrain Studio (Nuxt/Nitro)
  ├─ DB/Auth — Supabase pair OR plain PostgreSQL (managed pair)
  ├─ GitHub App
  ├─ Redis (optional, recommended for multi-instance)
  ├─ Resend (optional; required with the managed pair)
  ├─ Stripe (optional)
  └─ R2 / S3-compatible storage (optional)
```

## Self-Host Profiles

### Community Edition (`community` profile)

Use this when you want to run the AGPL core yourself without the `ee/` proprietary implementations. This is the zero-license path — no agreement with Contentrain required, AGPL-3.0 + `LICENSE-EXCEPTIONS` terms apply.

Recommended config:

- either provider pair configured (Supabase, or plain PostgreSQL with the managed pair)
- GitHub App configured
- `ee/` directory absent (or excluded from the deployed image)
- no Polar / Stripe env vars
- no Redis for local/dev, Redis for production if multi-instance
- `NUXT_ANTHROPIC_API_KEY` set (the operator provides the AI key; `ai.studio_key` is disabled in Community Edition)

This gives you:

- authenticated app + workspace/project flows + repository connection
- full content operations (all 4 kinds, all 27 field types)
- chat with operator-provided Anthropic key
- auto-merge workflow, forms (submission storage + captcha + notifications)
- every workspace resolves to the fixed `community` plan tier with unlimited usage

Features not available in Community Edition (require `ee/`):

- Media upload / library / CDN delivery
- BYOA key management UI, Conversation API, outbound webhooks
- Reviewer / Viewer project roles (degrade to Editor silently on the server; UI hides the dropdown options)
- SSO, white-label branding (roadmap)

See [EDITIONS.md](EDITIONS.md) for the authoritative feature matrix.

### On-Premises Enterprise (`on-premise` profile)

Use this when you have an executed On-Premises Deployment License (`ee/LICENSE` §2.2) and want to run the full feature set on your own infrastructure. Billing is off; the operator sets the workspace plan tier directly (default `enterprise`).

Recommended config:

- either provider pair configured + GitHub App configured
- `ee/` directory present (matching the core release tag)
- no Polar / Stripe env vars (billing off)
- Redis for multi-instance
- Resend or internal SMTP for email
- Cloudflare R2 (or S3-compatible) for CDN/media
- `NUXT_DEPLOYMENT_PROFILE=on-premise` (optional — auto-detected from ee/ + empty billing env)

Plan management:

```sql
-- Enterprise tier (default when workspace.plan is null)
UPDATE workspaces SET plan = 'enterprise' WHERE id = '…';
```

### Operational Mode (adds to either profile)

Use this when you want delivery and automation surfaces on top of Community or On-Premises:

- Redis (distributed rate limiting)
- Resend (or internal SMTP)
- R2 / S3-compatible storage
- Polar or Stripe if you want managed billing on-prem (uncommon; promotes the profile to `dedicated` with subscription-driven plans)

## Secret Rotation

For session/encryption secret rotation:

1. set a new `NUXT_SESSION_SECRET`
2. keep the old value in `NUXT_SESSION_SECRET_PREVIOUS`
3. deploy
4. allow keys/sessions to re-encrypt or refresh
5. remove the previous secret after the migration window

Managed pair extras: rotating `NUXT_AUTH_JWT_SECRET` invalidates every outstanding access/refresh token — users re-login; nothing else breaks. `NUXT_SESSION_PASSWORD` stores no durable state and can be rotated freely.

## Backups and Persistence

Studio itself does not require local writable application state beyond normal container runtime behavior. Back up:

- database
- object storage
- Git repositories
- deployment secrets

Do not treat the Studio container filesystem as durable state.

## Security Expectations

- run behind TLS
- restrict access to internal services
- keep service role keys private
- use private networking where possible
- configure webhook secrets
- prefer `rediss://` for Redis outside trusted networks

See [../SECURITY.md](../SECURITY.md) for disclosure policy and security scope.

## Suggested First Production Rollout

1. deploy a single instance
2. connect database/auth
3. configure GitHub App
4. verify login and workspace/project flow
5. enable AI
6. enable Redis if you scale past one instance
7. enable email, CDN/media, and billing only when needed

## AGPL §13 Source-Disclosure Obligation

If you operate a modified version of the AGPL core as a network service (anyone other than you interacts with it over the network), AGPL-3.0 §13 requires you to make the Corresponding Source available to those users. Studio's built-in `/about` page renders a source link + deployment metadata to satisfy this — do not remove it without adding an equivalent notice elsewhere. `LICENSE-EXCEPTIONS` §7(c) also requires a visible attribution line referencing the upstream repository.

## Related Docs

- [EDITIONS.md](EDITIONS.md) — Community vs Enterprise feature matrix
- [DEPLOYMENT_PROFILES.md](DEPLOYMENT_PROFILES.md) — 12 supported scenarios + env checklist
- [LICENSING.md](LICENSING.md) — SKU × license type × scenario table
- [DOCKER.md](DOCKER.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)
- [../.env.example](../.env.example)
- [../LICENSE](../LICENSE) + [../LICENSE-EXCEPTIONS](../LICENSE-EXCEPTIONS) — AGPL-3.0 + §7 attribution/trademark terms
