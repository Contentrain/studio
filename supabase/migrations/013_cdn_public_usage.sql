-- 013_cdn_public_usage.sql
-- Meter keyless public-media delivery (projects.cdn_public_media).
--
-- CDN bandwidth/requests are aggregated in `cdn_usage`, keyed per
-- (project_id, api_key_id, period_start). Public-media requests carry NO API
-- key, so they cannot be attributed to a key row. We record them as a
-- project-level bucket with api_key_id = NULL.
--
-- The existing UNIQUE (project_id, api_key_id, period_start) does not dedupe
-- NULL keys (SQL treats NULLs as distinct), so a NULL-key upsert would append a
-- new row per request. A partial unique index over (project_id, period_start)
-- WHERE api_key_id IS NULL gives the NULL-key bucket a single, conflict-able
-- target — the FK on api_key_id already permits NULL.

CREATE UNIQUE INDEX IF NOT EXISTS cdn_usage_project_period_public_key
  ON public.cdn_usage (project_id, period_start)
  WHERE api_key_id IS NULL;

-- Atomic accumulate for the keyless (public-media) bucket. Mirrors
-- increment_cdn_usage but targets the partial index above.
CREATE OR REPLACE FUNCTION public.increment_cdn_usage_public(
  p_project_id uuid,
  p_period_start date,
  p_request_count bigint,
  p_bandwidth_bytes bigint
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.cdn_usage (
    project_id, api_key_id, period_start,
    request_count, bandwidth_bytes
  )
  VALUES (
    p_project_id, NULL, p_period_start,
    p_request_count, p_bandwidth_bytes
  )
  ON CONFLICT (project_id, period_start) WHERE api_key_id IS NULL DO UPDATE SET
    request_count = public.cdn_usage.request_count + p_request_count,
    bandwidth_bytes = public.cdn_usage.bandwidth_bytes + p_bandwidth_bytes;
END;
$$;
