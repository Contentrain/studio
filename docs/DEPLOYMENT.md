# Deployment Guide

Contentrain Studio is designed for self-hosted deployment. The product is a single Nuxt/Nitro application with external dependencies for auth/data, GitHub integration, optional billing, optional object storage, and optional Redis.

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
- Anthropic API key for Studio-hosted AI
- Cloudflare R2 for CDN/media delivery
- Stripe for hosted billing

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

If billing is enabled:

- Set Stripe server keys and price IDs
- Set `NUXT_PUBLIC_BILLING_ENABLED=true`
- Verify webhook delivery to the billing webhook route

If billing is not enabled:

- Leave Stripe keys unset
- Leave `NUXT_PUBLIC_BILLING_ENABLED` unset
- Studio will operate in self-host/no-billing mode

### CDN / Media

If CDN/media delivery is enabled:

- Set R2 account and credentials
- Verify bucket access and object lifecycle expectations

### Redis

For multi-instance production:

- set `REDIS_URL`
- use `REDIS_CA_CERT` if you need custom CA trust with `rediss://`

Without Redis, rate limiting degrades to in-memory and is only suitable for single-instance or low-risk setups.

## Railway Notes

This repo includes [railway.toml](../railway.toml) for Docker-based deployment.

The current deployment profile:

- builds from `Dockerfile`
- starts with `node .output/server/index.mjs`
- healthchecks `GET /api/health`

## Post-Deploy Smoke Checks

After first deploy, verify:

- `/api/health` returns `200`
- login page loads
- OAuth callback URLs are correct
- a workspace can be created and listed
- GitHub installation flow completes
- a repository can be scanned/connected
- at least one chat/content flow works
- billing, email, CDN, and media surfaces behave according to your configured environment

## Release Validation

Run before cutting a release image:

```bash
pnpm release:check
```

For tag policy, container image tags, rollback, and GitHub release automation, see [RELEASING.md](RELEASING.md).
