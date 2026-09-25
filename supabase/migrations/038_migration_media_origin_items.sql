-- 038: a migration's media still at the old site's address joins the same job.
--
-- Migrate commits most media into the repository, but files over its repo caps
-- (one file too large, the total or the count reached) stay at their old
-- WordPress address and are listed as `studioRecommended` in media.json. When
-- the old server goes away, those break. They are imported by the same job as
-- the repository files (037), fetched from the manifest's origin instead of
-- read from a blob:
--
--   jobs.origin        the manifest's origin; the only host a fetch may reach.
--   items.source_url   set for a file fetched from the origin (then blob_sha
--                      is null); the item's key (repo_path) is that URL.
--   items.attempts,
--   items.retry_at     a fetch that failed for a passing reason (timeout,
--                      5xx, 429, connection) is retried later, a few times,
--                      instead of failing the file — and the batch moves on,
--                      so a slow origin never holds the lease.
--
-- settle takes the bytes actually stored: a remote file's size is known only
-- once fetched (the manifest may not say it).

ALTER TABLE public.migration_media_jobs ADD COLUMN origin text;

ALTER TABLE public.migration_media_items ALTER COLUMN blob_sha DROP NOT NULL;
ALTER TABLE public.migration_media_items
  ADD COLUMN source_url text,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN retry_at timestamp with time zone;
ALTER TABLE public.migration_media_items
  ADD CONSTRAINT migration_media_items_one_source
  CHECK ((blob_sha IS NULL) <> (source_url IS NULL));

DROP FUNCTION public.settle_migration_media_item(uuid, uuid, text, boolean, uuid, text, boolean, text, integer, timestamptz);

CREATE FUNCTION public.settle_migration_media_item(
  p_job uuid, p_token uuid, p_path text, p_ok boolean,
  p_asset uuid, p_delivery_url text, p_deduped boolean, p_error text, p_status_code integer,
  p_now timestamptz, p_bytes bigint DEFAULT NULL
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
      error = p_error, status_code = p_status_code, updated_at = p_now, retry_at = NULL,
      bytes = CASE WHEN p_ok AND p_bytes IS NOT NULL AND p_bytes >= 0 THEN p_bytes ELSE bytes END
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

-- A passing failure: the item stays pending, counted and parked until p_retry_at. Returns its attempts so far,
-- or null when the caller no longer holds the claim (or the item is not pending).
CREATE FUNCTION public.defer_migration_media_item(
  p_job uuid, p_token uuid, p_path text, p_error text, p_status_code integer, p_retry_at timestamptz, p_now timestamptz
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE tries integer;
BEGIN
  PERFORM 1 FROM public.migration_media_jobs WHERE id = p_job AND claim_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.migration_media_items
  SET attempts = attempts + 1, retry_at = p_retry_at, error = p_error, status_code = p_status_code, updated_at = p_now
  WHERE job_id = p_job AND repo_path = p_path AND state = 'pending'
  RETURNING attempts INTO tries;
  RETURN tries;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_migration_media_item(uuid, uuid, text, boolean, uuid, text, boolean, text, integer, timestamptz, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.defer_migration_media_item(uuid, uuid, text, text, integer, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_migration_media_item(uuid, uuid, text, boolean, uuid, text, boolean, text, integer, timestamptz, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_migration_media_item(uuid, uuid, text, text, integer, timestamptz, timestamptz) TO service_role;
