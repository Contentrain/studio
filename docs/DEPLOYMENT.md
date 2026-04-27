# Deployment Guide

Contentrain Studio supports self-hosting of the AGPL core and managed operation of paid plans. The product is a single Nuxt/Nitro application with external dependencies for auth/data, GitHub integration, optional billing, optional object storage, and optional Redis. This guide focuses on deploying it yourself.

## Editions and Profiles

Before picking a topology, pick an **edition** (Community or Enterprise) and a **profile** (`managed` / `dedicated` / `on-premise` / `community`). These choices decide which features are available and how billing behaves.

- **Edition** — whether the `ee/` directory is present at build time. See [EDITIONS.md](EDITIONS.md).
- **Profile** — the preset that configures billing mode and plan source. See [DEPLOYMENT_PROFILES.md](DEPLOYMENT_PROFILES.md) for the 12 supported scenarios.

Auto-detection picks the profile at boot from the combination of `ee/` presence + configured payment plugins; `NUXT_DEPLOYMENT_PROFILE` overrides. For dedicated single-tenant hosting you **must** set it explicitly.

## Deployment Shapes

Recommended options:

- Single container behind a reverse proxy
- Railway-style Docker deployment
- VM or bare-metal Docker deployment
- Kubernetes with one web deployment plus external backing services

## Minimum Production Dependencies

Required:

- PostgreSQL/Auth stack via Supabase-compatible deployment
- GitHub App for repository operations
- Application secrets in environment variables

Optional but recommended:

- Redis for distributed rate limiting
- Resend or compatible app-email provider
- Anthropic API key for the operator-managed AI surface
- Cloudflare R2 for CDN/media delivery
- Stripe for billing when commercial plans are enabled

## Production Checklist

### Base

- Set `NODE_ENV=production`
- Set `NUXT_PUBLIC_SITE_URL` to the public application URL
- Set a strong `NUXT_SESSION_SECRET`
- Keep `NUXT_SESSION_SECRET_PREVIOUS` available during secret rotation windows
- Run with TLS in front of the app

### Database / Auth

- Provide `NUXT_SUPABASE_URL`
- Provide `NUXT_SUPABASE_SERVICE_ROLE_KEY`
- Provide `NUXT_SUPABASE_ANON_KEY`
- Apply all migrations before first production traffic

### GitHub

- Create a GitHub App
- Configure:
  - `NUXT_GITHUB_APP_ID`
  - `NUXT_GITHUB_CLIENT_ID`
  - `NUXT_GITHUB_CLIENT_SECRET`
  - `NUXT_GITHUB_PRIVATE_KEY`
  - `NUXT_GITHUB_WEBHOOK_SECRET`
- Set `NUXT_PUBLIC_GITHUB_APP_SLUG` if your app slug differs from the default

### Email

- Set `NUXT_RESEND_API_KEY`
- Set `NUXT_EMAIL_SENDER_ADDRESS`
- Set `NUXT_EMAIL_SENDER_NAME`
- If local Supabase auth SMTP is in use, also set `RESEND_API_KEY`

### Billing

Managed profile (Polar or Stripe):

- Set Polar env vars (recommended) or Stripe server keys + price IDs
- `NUXT_PUBLIC_BILLING_ENABLED` is derived automatically at boot — set it only to override
- Verify webhook delivery to `/api/billing/webhook/polar` (or `/stripe`)

On-premise / Community (no managed billing):

- Leave Polar + Stripe env vars unset
- `NUXT_PUBLIC_BILLING_ENABLED` auto-resolves to `false`
- Plan is set via `UPDATE workspaces SET plan = 'enterprise'` on on-premise; fixed to `community` on Community Edition

See [PAYMENT_PROVIDERS.md](PAYMENT_PROVIDERS.md) for the Polar setup and [DEPLOYMENT_PROFILES.md](DEPLOYMENT_PROFILES.md) for the profile × env matrix.

### CDN / Media

If CDN/media delivery is enabled:

- Set R2 account and credentials
- Verify bucket access and object lifecycle expectations

### Redis

For multi-instance production:

- set `REDIS_URL`
- use `REDIS_CA_CERT` if you need custom CA trust with `rediss://`

Without Redis, rate limiting degrades to in-memory and is only suitable for single-instance or low-risk setups.

## Deployment Environments

Studio is trunk-based (see [CONTRIBUTING.md](../CONTRIBUTING.md) → Branch Model). The managed deployment topology mirrors that:

| Environment | Source                                         | Trigger                              |
|-------------|------------------------------------------------|--------------------------------------|
| Staging     | `main` branch, built by Railway                | Every merge to `main` (auto)         |
| Production  | `ghcr.io/contentrain/studio` image, specific tag | Maintainer promotes after tag release |

Staging verification happens on the Railway-deployed environment fed directly from `main`. Production runs the container image published by [.github/workflows/release.yml](../.github/workflows/release.yml) on `v*` tag push — see [RELEASING.md](RELEASING.md) for the tag, image-tag policy, and promotion flow.

Self-hosters deploy the published container image by tag, not the branch source — see [SELF_HOSTING.md](SELF_HOSTING.md) and [DOCKER.md](DOCKER.md).

## Railway Notes

This repo includes [railway.toml](../railway.toml) for Docker-based deployment.

The current deployment profile:

- builds from `Dockerfile`
- starts with `node .output/server/index.mjs`
- exposes `GET /api/health` (Railway healthcheck is temporarily disabled in `railway.toml` pending a port-routing fix — re-enable once resolved)

## Post-Deploy Smoke Checks

After first deploy, verify:

- `/api/health` returns `200`
- login page loads
- `/about` page renders and links to the Corresponding Source (AGPL §13)
- Deployment snapshot on `/about` shows the correct profile / edition / billing mode
- OAuth callback URLs are correct
- a workspace can be created and listed
- GitHub installation flow completes
- a repository can be scanned/connected
- at least one chat/content flow works
- billing, email, CDN, and media surfaces behave according to your configured profile (see [DEPLOYMENT_PROFILES.md](DEPLOYMENT_PROFILES.md))
- For Community Edition: AI Keys, Conversation API, Webhook tabs are hidden; Members panel offers only the Editor project role

## Release Validation

Run before cutting a release image:

```bash
pnpm release:check
```

For tag policy, container image tags, rollback, and GitHub release automation, see [RELEASING.md](RELEASING.md).
