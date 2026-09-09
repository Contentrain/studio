-- Claim is temporary ownership, not delivery. Unacknowledged work is retried
-- after the lease expires. External hooks are at-least-once (not exactly-once).
ALTER TABLE public.scheduled_publications
  ADD COLUMN claim_token uuid,
  ADD COLUMN lease_until timestamptz;

CREATE OR REPLACE FUNCTION public.claim_due_scheduled_publications(p_now timestamptz, p_limit integer)
RETURNS SETOF public.scheduled_publications
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.scheduled_publications
    WHERE fired_at IS NULL AND fire_at <= p_now
      AND (lease_until IS NULL OR lease_until <= p_now)
    ORDER BY fire_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE public.scheduled_publications sp
  SET claim_token = gen_random_uuid(), lease_until = p_now + interval '15 minutes', updated_at = p_now
  FROM due WHERE sp.id = due.id RETURNING sp.*;
END;
$$;

CREATE FUNCTION public.settle_scheduled_publication(p_id uuid, p_token uuid, p_success boolean, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE changed integer;
BEGIN
  UPDATE public.scheduled_publications
  SET fired_at = CASE WHEN p_success THEN p_now ELSE NULL END,
      claim_token = NULL,
      lease_until = CASE WHEN p_success THEN NULL ELSE p_now + interval '1 minute' END,
      updated_at = p_now
  WHERE id = p_id AND claim_token = p_token AND fired_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_scheduled_publication(uuid, uuid, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_scheduled_publication(uuid, uuid, boolean, timestamptz) TO service_role;
