-- 032: reserve a whole turn's credits up front (AI-8).
--
-- `increment_agent_usage_if_allowed` (027/030) reserves 1 credit and the
-- turn-end settle adds `credits - 1`. Every turn that starts below the
-- limit therefore passes, and two turns started together can each
-- settle up to the per-message ceiling on top of a nearly full pool:
-- the pool overshoots by (ceiling - 1) per concurrent turn.
--
-- This function reserves the turn's ceiling instead — or what is left
-- of the pool, whichever is smaller — under the same advisory lock, and
-- returns how much it granted. The chat route spends against that grant
-- as a dollar budget and the settle (`increment_agent_usage_tokens_v3`,
-- whose delta may be negative) refunds what the turn did not use. Two
-- concurrent turns can no longer take more than the pool holds.
--
-- Same pool semantics as 030: only `source = 'studio'` counts, and a
-- non-studio (BYOA) reservation is never refused and books 1.
-- `increment_agent_usage_if_allowed` stays for the Conversation API
-- path and rolling deploys; nothing is dropped here.

CREATE OR REPLACE FUNCTION public.reserve_agent_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_month text,
  p_source text,
  p_limit integer,
  p_amount integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_current INTEGER;
  v_granted INTEGER;
BEGIN
  -- Same lock key as increment_agent_usage_if_allowed: both reserve
  -- from the same pool, so they must serialize against each other.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_workspace_id::text || ':agent:' || p_month)
  );

  SELECT COALESCE(SUM(message_count), 0) INTO v_current
  FROM public.agent_usage
  WHERE workspace_id = p_workspace_id
    AND month = p_month
    AND source = 'studio';

  IF p_source = 'studio' THEN
    IF v_current >= p_limit THEN
      RETURN jsonb_build_object('allowed', false, 'granted', 0, 'current_count', v_current);
    END IF;
    v_granted := LEAST(GREATEST(p_amount, 1), p_limit - v_current);
  ELSE
    v_granted := 1;
  END IF;

  INSERT INTO public.agent_usage (
    workspace_id, user_id, api_key_id, month, source,
    message_count, input_tokens, output_tokens
  )
  VALUES (
    p_workspace_id, p_user_id, NULL, p_month, p_source,
    v_granted, 0, 0
  )
  ON CONFLICT (workspace_id, user_id, month, source) DO UPDATE SET
    message_count = public.agent_usage.message_count + v_granted,
    updated_at = now();

  RETURN jsonb_build_object(
    'allowed', true,
    'granted', v_granted,
    'current_count', CASE WHEN p_source = 'studio' THEN v_current + v_granted ELSE v_current END
  );
END;
$$;

-- Server-side only (the admin client), like 025's settle function.
REVOKE ALL ON FUNCTION public.reserve_agent_credits(uuid, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_agent_credits(uuid, uuid, text, text, integer, integer) TO service_role;
