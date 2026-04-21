<!--
  Base branch: `staging` (default).
  `main` only receives code through maintainer-cut `staging → main` release PRs.
  See CONTRIBUTING.md → Branch Model if unsure.
-->

## Summary

<!-- What does this PR change? Keep it brief and concrete. -->

## Related Issue

<!-- Link the issue or discussion: closes #123 -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Test-only change
- [ ] Breaking change

## Changes

- 

## Architecture Rules

- [ ] Provider boundaries are preserved (no direct vendor implementation leaks outside `server/providers/`)
- [ ] No raw Tailwind color families were introduced outside the approved Studio palette
- [ ] No new hardcoded user-facing strings were introduced where dictionary-backed content is required
- [ ] No AGPL core / `ee/` boundary violations were introduced

## Verification

- [ ] Base branch is `staging` (unless this is a maintainer-cut release PR)
- [ ] Commits are signed off (`git commit -s`)
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] Relevant tests were run
- [ ] Docs updated if behavior, contracts, or contributor workflows changed

## Test Coverage

- [ ] `pnpm test:unit`
- [ ] `pnpm test:integration`
- [ ] `pnpm test:nuxt`
- [ ] `pnpm test:rls`
- [ ] `pnpm test:e2e`

## Notes

<!-- Risk, rollout notes, follow-ups, or anything reviewers should check closely. -->
