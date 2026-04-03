# Self-Hosting Guide

Contentrain Studio supports self-hosting of the AGPL core. This guide covers the self-managed deployment path; managed Pro/Enterprise operation may also be available separately.

This guide describes the practical model for operating Studio in your own environment.

## Core Principles

- the app is stateless
- Git repositories remain external and authoritative
- auth/data are supplied through provider-backed integrations
- enterprise features degrade safely when `ee/` functionality or external services are absent

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

## Self-Host Modes

### Minimal Core Mode

Use this when you want to run the AGPL core yourself without premium operational surfaces.

Recommended config:

- Supabase configured
- GitHub App configured
- no Stripe
- no R2
- no Redis for local/dev, Redis for production if multi-instance

This gives you:

- authenticated app
- workspace/project flows
- repository connection
- structured content operations
- AI/chat flows according to configured keys

### Operational Mode

Use this when you also want delivery and automation surfaces.

Add:

- Redis
- Resend
- R2
- Stripe if billing is required

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

## Related Docs

- [DOCKER.md](DOCKER.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)
- [../.env.example](../.env.example)
