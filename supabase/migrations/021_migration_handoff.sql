-- Migration handoff intake — SHARED lineage (both provider pairs).
--
-- A migrated WordPress site arrives with a `contentrain-handoff.json` at the
-- repository root (the `MigrationHandoff` contract from @contentrain/types,
-- written by the Contentrain Migrate tool): what the source site used, what
-- happened to each capability, and which runtime offers are open (comments,
-- forms, …). Studio reads it when the repository is connected (and on demand)
-- and keeps the validated document on the project so the overview panel and
-- the chat agent can act on it without re-reading the repo.

ALTER TABLE public.projects
  ADD COLUMN migration_handoff jsonb,
  ADD COLUMN migration_handoff_synced_at timestamp with time zone;
