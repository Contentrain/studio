# WordPress runtime integration: session ownership

Updated 2026-09-10. Each repository owns its implementation and evidence.

| Session | Owned scope | Next integration |
| --- | --- | --- |
| AI correction | Importer identity/schedule correctness, static emitter routes, SDK/loader publication windows, changesets | Publish corrected versions; hand over options and regenerated identity requirements |
| Studio correction | Idempotent form approval, request UI state, publication-window parity, HTTP/DB isolation acceptance | Merge/deploy corrected server and rerun hosted journeys |
| Founder / Migrate | Intake, orchestration, route/editability/family/mobile verdicts, media completeness, package consumption | Adopt released packages; enforce missing-measurement failures and narrowly scoped runtime exceptions |

Forms SDK and comments client payload alignment and portable mounting are
implemented. They are no longer pending first steps. Source tests, package
publication, consumer adoption and hosted acceptance are separate milestones.

For public local builds use `generate --published` or loader `publishedOnly: true`.
`--at` is a fixed ISO build clock for reproducibility. Scheduled WordPress imports
carry published status plus a future window; all public consumers must honor that
window. A rebuild/deploy trigger is still required when a deadline arrives.

## Boundaries and handoff receipt

- AI: MIT portable code/contracts; Studio: provider-backed runtime with existing
  core/EE boundaries; Migrate: private orchestration, no Studio source imports.
- Managing content remains conversation-first. No new admin editor is part of
  this work. Visitor-facing forms/comments are distinct from management UI.
- Each session reports commit/PR, affected files, request/response fixtures,
  tests actually run, package versions and remaining blockers.
- Migrate is owned by the founder’s active session. The AI/Studio correction
  session must not edit its files, lockfile or acceptance verdicts.
- Final gate: generated Astro → submit → Studio DB → moderation → public GET;
  pending/private content must not appear publicly. Media and scheduled public
  visibility have separate acceptance gates and are not implied by this flow.
