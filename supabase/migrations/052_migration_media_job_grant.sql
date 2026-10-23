-- 052: a bundle grant's media import says which grant started it.
--
-- When a bundle grant's site binding lands, Studio starts the project's media
-- import on its own (`bindMigrateGrantSite`) and, once the job is done, points
-- the content at Studio Media through the same write path the binding takes
-- (`runMigrationMediaTick` → `applyMigrationMedia`, local files kept).
--
--   jobs.migrate_grant_id   set only by that automatic start. A job the owner
--                           starts by hand leaves it NULL and is never applied
--                           without the owner's own dry run.
--
-- ON DELETE SET NULL: the job and its imported media outlive the grant row.
-- Re-running is a no-op.

ALTER TABLE public.migration_media_jobs
  ADD COLUMN IF NOT EXISTS migrate_grant_id uuid REFERENCES public.migrate_grants(id) ON DELETE SET NULL;
