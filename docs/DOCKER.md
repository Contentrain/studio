# Docker Guide

This repository ships with a production Dockerfile for self-hosted deployments.

## What the Docker Image Contains

- built Nuxt/Nitro server output
- generated `.contentrain` assets required by the UI string/content client
- `git` in the runtime container for repository operations
- non-root `studio` user

The container listens on port `3000`.

## Build the Image

```bash
docker build -t contentrain-studio .
```

## Run the Image

```bash
docker run \
  --name contentrain-studio \
  --env-file .env \
  -p 3000:3000 \
  contentrain-studio
```

Health endpoint:

- `GET /api/health`

## Required Runtime Secrets

At minimum, production requires:

- `NUXT_SESSION_SECRET`
- `NUXT_SUPABASE_URL`
- `NUXT_SUPABASE_SERVICE_ROLE_KEY`
- `NUXT_SUPABASE_ANON_KEY`

Depending on enabled surfaces, you may also need:

- GitHub App credentials
- Anthropic API key
- Resend sender configuration
- Stripe keys
- R2 credentials
- Redis URL

See [../.env.example](../.env.example) and [SELF_HOSTING.md](SELF_HOSTING.md).

## Operational Notes

- Persist your environment outside the image
- Use `rediss://` for Redis when crossing untrusted networks
- Terminate TLS at a reverse proxy or platform load balancer
- Keep the container stateless; database, object storage, Redis, and SMTP stay external
- If you rotate `NUXT_SESSION_SECRET`, also set `NUXT_SESSION_SECRET_PREVIOUS` during the migration window

## Example Reverse Proxy Expectations

Your reverse proxy should:

- forward HTTPS traffic to port `3000`
- preserve `Host` and standard forwarding headers
- set a sane request body limit for uploads
- avoid caching authenticated application routes

## Release Check

Before shipping a Docker deployment:

```bash
pnpm release:check
```

The full release flow, image-tag policy, and GitHub Actions automation are documented in [RELEASING.md](RELEASING.md).
