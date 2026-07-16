-- Serialize CDN builds: at most one in-flight build per project.
--
-- CDN builds are triggered fire-and-forget from two callsites (the GitHub
-- push webhook and the manual "Rebuild now" endpoint) with no coordination.
-- Two builds for the same project could run concurrently and race on the
-- shared R2 namespace — in particular a manual full rebuild's "delete every
-- object not in this build" cleanup can wipe a concurrent webhook build's
-- fresh uploads, stranding content until the next rebuild.
--
-- `claim_cdn_build` is the single atomic gate both callsites now go through
-- (via DatabaseProvider.createCDNBuild). It returns the new build id, or NULL
-- when a build is already in flight so the caller can skip/defer. A per-project
-- advisory lock serializes the claim decision only (it is transaction-scoped —
-- released when this function's statement commits, NOT held for the build's
-- lifetime, so it never ties up a pool connection). Builds whose process died
-- before flipping status out of 'building' are reclaimed after p_stale_seconds
-- so a crash can't block a project's builds forever.
--
-- SECURITY DEFINER + no explicit grant, mirroring increment_mcp_cloud_usage_
-- if_allowed: both provider impls call it through the service-role path. Shared
-- lineage (cdn_builds lives on both provider pairs); applied by the Supabase
-- CLI and by scripts/migrate-postgres.mjs alike.

CREATE FUNCTION public.claim_cdn_build(
  p_project_id uuid,
  p_trigger_type text,
  p_commit_sha text,
  p_branch text,
  p_stale_seconds integer
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Serialize concurrent claims for this project (txn-scoped advisory lock).
  PERFORM pg_advisory_xact_lock(hashtext('cdn_build:' || p_project_id::text));

  -- Reclaim slots held by builds whose process died mid-flight.
  UPDATE public.cdn_builds
     SET status = 'failed',
         error_message = 'stale build reclaimed (process likely died)',
         completed_at = now()
   WHERE project_id = p_project_id
     AND status IN ('pending', 'building')
     AND started_at < now() - make_interval(secs => p_stale_seconds);

  -- A fresh build is already running → caller must not start another.
  IF EXISTS (
    SELECT 1
      FROM public.cdn_builds
     WHERE project_id = p_project_id
       AND status IN ('pending', 'building')
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.cdn_builds (project_id, trigger_type, commit_sha, branch, status)
  VALUES (p_project_id, p_trigger_type, p_commit_sha, p_branch, 'building')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
