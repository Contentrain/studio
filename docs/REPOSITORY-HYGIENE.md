# Repository Hygiene

This document covers maintainer-only repository cleanup work that should happen before wider release and external collaboration.

## `.internal/` Policy

`.internal/` is for private planning and operational notes. It must:

- stay ignored in `.gitignore`
- remain available locally for maintainers if needed
- never ship to GitHub as tracked project content

The current repository state already stops tracking `.internal/` at head. That fixes the problem for all future commits.

## Why History Cleanup Still Matters

If `.internal/` was committed in earlier revisions, removing it from the current tree is not enough. The content still exists in repository history and can be accessed from old commits, forks, mirrors, and packfiles.

If the goal is to fully purge those files from the public repository history, you need a history rewrite.

## Recommended Cleanup Method

Use `git filter-repo` from a fresh mirror clone, not from a normal working tree.

High-level flow:

1. create a mirror clone of the repository
2. rewrite history to remove `.internal/`
3. force-push all refs
4. invalidate old clones and branches
5. ask collaborators to re-clone or hard-reset to the rewritten history

## Example Command Sequence

Run this from a separate temporary directory, not from your active working copy:

```bash
git clone --mirror git@github.com:Contentrain/studio.git studio-clean.git
cd studio-clean.git
git filter-repo --path .internal --invert-paths
git push --force --mirror origin
```

## After the Force-Push

After rewriting history:

- confirm `.internal/` no longer appears in `git log --all -- .internal`
- close or rebase any open PRs based on old history
- notify collaborators that old clones are stale
- ask maintainers to re-clone or reset from the rewritten `main`
- verify GitHub Actions and branch protections still behave as expected

## Operational Risks

History rewrites are disruptive:

- open PRs can break
- old commit SHAs become invalid
- forks and mirrors will diverge
- external references to old SHAs stop being meaningful

Do not do the purge during active release tagging or while multiple long-lived PRs are open.

## Recommended Timing

Best time to run the purge:

- before public launch
- before announcing the repository widely
- before creating the first durable stable release line

If you are about to publish `v0.1.0-beta.1`, do the history purge first, then cut the beta tag on top of the cleaned history.
