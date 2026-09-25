-- 037: moving a migration's media into Studio Media, as a job that survives restarts.
--
-- A migrated site can carry hundreds of images; one request cannot import
-- them. `POST …/migration/media` records a job and one item per file (its
-- repository path and the blob sha it was read at), and a Nitro worker
-- (`server/plugins/migration-media-worker.ts`) works through the items in
-- small batches under a lease:
--
--   claim   — one open job at a time per claim, SKIP LOCKED, lease 5 min;
--             a crashed worker's lease simply expires and the next tick
--             takes the job over where it stopped (items are the cursor).
--   settle  — one item at a time, only by the holder of the job's claim
--             token; the job's counters move in the same statement.
--   finish  — `done` / `failed`, or `paused_quota` when the workspace's
--             storage ran out (the remaining items stay pending; resuming
--             after an upgrade picks them up), or back to `running` with the
--             lease released when a batch ends with work left.
--
-- One open job per project (preparing / queued / running / paused_quota): a
-- second start returns the open one. A job is written as `preparing` and only
-- becomes `queued` once all its items are in, so a worker can never claim a
-- job whose items are still arriving (and find it empty). Service-role only:
-- RLS on, no policies.

CREATE TABLE public.migration_media_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Where the manifest and the blobs were read (branch name and, when known, its commit).
  manifest_ref text NOT NULL,
  manifest_commit text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('preparing', 'queued', 'running', 'paused_quota', 'done', 'failed', 'canceled')),
  total integer NOT NULL CHECK (total >= 0),
  done integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  deduped integer NOT NULL DEFAULT 0,
  bytes_done bigint NOT NULL DEFAULT 0,
  error text,
  claim_token uuid,
  lease_until timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone
);

CREATE UNIQUE INDEX migration_media_jobs_one_open
  ON public.migration_media_jobs (project_id)
  WHERE status IN ('preparing', 'queued', 'running', 'paused_quota');
CREATE INDEX idx_migration_media_jobs_claimable
  ON public.migration_media_jobs (created_at)
  WHERE status IN ('queued', 'running');

CREATE TABLE public.migration_media_items (
  job_id uuid NOT NULL REFERENCES public.migration_media_jobs(id) ON DELETE CASCADE,
  repo_path text NOT NULL,
  blob_sha text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  mime text NOT NULL,
  width integer,
  height integer,
  alt text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  asset_id uuid,
  delivery_url text,
  deduped boolean NOT NULL DEFAULT false,
  error text,
  status_code integer,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, repo_path)
);

CREATE INDEX idx_migration_media_items_pending
  ON public.migration_media_items (job_id, repo_path)
  WHERE state = 'pending';

ALTER TABLE public.migration_media_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.migration_media_items ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.claim_migration_media_job(p_now timestamptz, p_lease_seconds integer)
RETURNS SETOF public.migration_media_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  RETURN QUERY
  WITH next AS (
    SELECT id FROM public.migration_media_jobs
    WHERE status IN ('queued', 'running')
      AND (lease_until IS NULL OR lease_until <= p_now)
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.migration_media_jobs j
  SET status = 'running', claim_token = gen_random_uuid(),
      lease_until = p_now + make_interval(secs => p_lease_seconds), updated_at = p_now
  FROM next WHERE j.id = next.id RETURNING j.*;
END;
$$;

CREATE FUNCTION public.settle_migration_media_item(
  p_job uuid, p_token uuid, p_path text, p_ok boolean,
  p_asset uuid, p_delivery_url text, p_deduped boolean, p_error text, p_status_code integer,
  p_now timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE item_bytes bigint;
BEGIN
  -- Only the claim holder settles, and only a pending item: a worker whose lease was taken over cannot write.
  PERFORM 1 FROM public.migration_media_jobs WHERE id = p_job AND claim_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.migration_media_items
  SET state = CASE WHEN p_ok THEN 'done' ELSE 'failed' END,
      asset_id = p_asset, delivery_url = p_delivery_url, deduped = COALESCE(p_deduped, false),
      error = p_error, status_code = p_status_code, updated_at = p_now
  WHERE job_id = p_job AND repo_path = p_path AND state = 'pending'
  RETURNING bytes INTO item_bytes;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.migration_media_jobs
  SET done = done + CASE WHEN p_ok THEN 1 ELSE 0 END,
      failed = failed + CASE WHEN p_ok THEN 0 ELSE 1 END,
      deduped = deduped + CASE WHEN p_ok AND COALESCE(p_deduped, false) THEN 1 ELSE 0 END,
      bytes_done = bytes_done + CASE WHEN p_ok AND NOT COALESCE(p_deduped, false) THEN item_bytes ELSE 0 END,
      updated_at = p_now
  WHERE id = p_job;
  RETURN true;
END;
$$;

CREATE FUNCTION public.finish_migration_media_job(p_job uuid, p_token uuid, p_status text, p_error text, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE changed integer;
BEGIN
  IF p_status NOT IN ('running', 'paused_quota', 'done', 'failed') THEN
    RAISE EXCEPTION 'invalid status %', p_status;
  END IF;
  UPDATE public.migration_media_jobs
  SET status = p_status, error = p_error, claim_token = NULL, lease_until = NULL, updated_at = p_now,
      finished_at = CASE WHEN p_status IN ('done', 'failed') THEN p_now ELSE NULL END
  WHERE id = p_job AND claim_token = p_token;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_migration_media_job(timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_migration_media_item(uuid, uuid, text, boolean, uuid, text, boolean, text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_migration_media_job(uuid, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_migration_media_job(timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_migration_media_item(uuid, uuid, text, boolean, uuid, text, boolean, text, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_migration_media_job(uuid, uuid, text, text, timestamptz) TO service_role;
