-- 054: the setup of a migrated project (the setup wizard).
--
-- A site Migrate delivered is set up in Studio in a few steps: forms and comments run with Studio (the site
-- binding, 049), the old site's comments come over, the images move to Studio Media, the live site shows a change.
-- The steps' own state stays where it is (the grant, the comments, the media job); this records only what nothing
-- else does:
--
--   projects.migration_setup  what the owner chose and what the setup did, merged key by key
--                             (`merge_project_migration_setup`, so the worker and a click never overwrite each other):
--                               skip_forms | skip_comments | skip_images | skip_live  true when the owner skipped it
--                               media_apply   the outcome of the apply a Move click asked for (job, status, branch)
--                               live_check    the last test change (its nonce, branch, status) and when it was seen
--                               completed_at  every step done or skipped: the setup is over
--   projects.live_site_url    the address of the site's live build, as the owner gave it (https)
--   migration_media_jobs.apply_approver
--                             the owner or admin whose Move click asked for this import to be applied when it is
--                             done ({ id, email, role, workspaceId, deleteLocal }); the worker that closes the job
--                             applies it under their approval, re-asked against the branch at that time. NULL: the
--                             job is applied only by a later click (or, for a grant's own job, held for a reviewer).
--
-- Never secrets. Re-running is a no-op.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS migration_setup jsonb,
  ADD COLUMN IF NOT EXISTS live_site_url text;

ALTER TABLE public.migration_media_jobs
  ADD COLUMN IF NOT EXISTS apply_approver jsonb;

CREATE OR REPLACE FUNCTION public.merge_project_migration_setup(p_project uuid, p_patch jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
  UPDATE public.projects
  SET migration_setup = coalesce(migration_setup, '{}'::jsonb) || p_patch
  WHERE id = p_project
  RETURNING migration_setup;
$$;

REVOKE ALL ON FUNCTION public.merge_project_migration_setup(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_project_migration_setup(uuid, jsonb) TO service_role;
