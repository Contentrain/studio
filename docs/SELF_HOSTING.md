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
- Supabase-compatible auth/database deployment
- GitHub App credentials for repository operations
- A strong `NUXT_SESSION_SECRET`

### Optional

- Anthropic API key
- Resend sender configuration
- Stripe billing
- R2 object storage
- Redis

## Recommended Topology

```text
User
  ↓
Reverse Proxy / TLS
  ↓
Contentrain Studio (Nuxt/Nitro)
  ├─ Supabase-compatible DB/Auth
  ├─ GitHub App
  ├─ Redis (optional, recommended for multi-instance)
  ├─ Resend (optional)
  ├─ Stripe (optional)
  └─ R2 / S3-compatible storage (optional)
```

## Self-Host Profiles

### Community Edition (`community` profile)

Use this when you want to run the AGPL core yourself without the `ee/` proprietary implementations. This is the zero-license path — no agreement with Contentrain required, AGPL-3.0 + `LICENSE-EXCEPTIONS` terms apply.

Recommended config:

- Supabase configured
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

- Supabase configured + GitHub App configured
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
