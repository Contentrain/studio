# Releasing Guide

Contentrain Studio ships as a self-hosted application image, not as an npm package.

The release source of truth is:

- a semver Git tag
- a GitHub Release
- a Docker image published to `ghcr.io/contentrain/studio`

## Release Model

Studio is currently in the `0.x` line. Use semver honestly:

- first public testing cut: `v0.1.0-beta.1`
- subsequent testing cuts: `v0.1.0-beta.2`, `v0.1.0-beta.3`
- first stable cut: `v0.1.0`

Use prerelease tags for user-testing and validation rounds. Do not move `latest` on prereleases.

## What Gets Published

Published artifact:

- Docker image: `ghcr.io/contentrain/studio`

Not published from this repository:

- npm package
- public SDK package
- reusable UI library package

If Studio later exposes a publishable SDK or CLI, that should be extracted as a separate package boundary instead of publishing the root app.

## Local Release Flow

Before cutting a tag, make sure:

- `main` is clean and up to date
- `package.json` has the intended version
- `.env` and deploy secrets are already validated in a staging-like environment

Run the local release gate:

```bash
pnpm release:check
```

This runs:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:ci`
- `pnpm test:rls`
- `pnpm test:e2e`
- `pnpm build`

Then cut the release:

```bash
pnpm release
```

`pnpm release` is the controlled local entry point. It runs the full release gate first, then runs `changelogen --release` to update changelog and release metadata.

After review, push the release commit and tag:

```bash
git push origin main --follow-tags
```

That tag push is what triggers the automated release pipeline.

## GitHub Actions Automation

The release pipeline lives in [../.github/workflows/release.yml](../.github/workflows/release.yml).

Triggers:

- `push` on tags matching `v*`
- `workflow_dispatch` for republishing an existing tag manually

Pipeline steps:

1. Checkout the tagged source
2. Validate that `package.json` version matches the tag
3. Install dependencies with `pnpm install --frozen-lockfile`
4. Generate the Contentrain client with `npx contentrain generate`
5. Run lint, typecheck, tests, and build
6. Build and push the Docker image to GHCR
7. Create or update the GitHub Release entry

## Image Tag Policy

Every release publishes:

- exact tag: `ghcr.io/contentrain/studio:vX.Y.Z`
- exact prerelease tag: `ghcr.io/contentrain/studio:vX.Y.Z-beta.N`
- immutable commit tag: `ghcr.io/contentrain/studio:sha-<shortsha>`

Stable releases additionally publish:

- `ghcr.io/contentrain/studio:X.Y`
- `ghcr.io/contentrain/studio:X`
- `ghcr.io/contentrain/studio:latest`

Prereleases do **not** publish `latest`.

## Database and Migration Order

If a release includes database or RLS changes:

1. apply migrations first
2. deploy the new image
3. run smoke checks
4. promote traffic

Do not deploy a new image that depends on unapplied schema changes.

## Rollback

Rollback strategy:

1. identify the previous healthy image tag
2. redeploy that exact image tag
3. if needed, roll forward with a fix release instead of mutating old tags

Do not retag old images or reuse a published semver tag for different bits.

## Release Smoke Checks

After a release deploy:

- `/api/health` returns `200`
- login and callback flows work
- workspace list and project load work
- GitHub installation and repo connection work
- one chat/content change flow completes
- billing/media/CDN/forms surfaces behave according to the configured environment

## First `v0.1.0-beta.1` Cut Checklist

Before cutting the first public beta:

- merge the release automation and docs changes to `main`
- confirm `.internal/` is no longer tracked in Git
- verify `package.json` version is exactly `0.1.0-beta.1`
- verify GHCR package permissions for `GITHUB_TOKEN`
- verify the repository has Actions enabled for tag workflows
- verify production and staging env vars are present
- verify a dry-run deployment from the current Dockerfile succeeds
- run `pnpm release:check` locally on a clean tree
- review changelog contents for the beta cut
- create and push tag `v0.1.0-beta.1`
- watch the GitHub Actions release workflow through image push and GitHub Release creation
- deploy `ghcr.io/contentrain/studio:v0.1.0-beta.1`
- run post-deploy smoke checks

If the beta cut fails after tag push, fix forward with `v0.1.0-beta.2`. Do not mutate or reuse the failed tag.

## Notes for Operators

- Keep `NUXT_SESSION_SECRET_PREVIOUS` during session and BYOA key rotation windows
- Treat GHCR image tags as immutable deployment inputs
- Keep release notes aligned with the shipped tag, not with branch head
