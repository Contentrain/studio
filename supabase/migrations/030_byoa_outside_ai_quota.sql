-- 030: a BYOA turn is outside the AI credit quota.
--
-- The AI credit quota prices what Studio pays Anthropic for. A turn run
-- on the user's own key (`source = 'byoa'`) costs Studio nothing, yet
-- 027's reservation summed every source of the workspace and applied the
-- limit to every caller. So BYOA turns ate the credits of members on the
-- Studio key, and a BYOA user was refused once the pool was full — for
-- work their own key was paying for.
--
-- Two changes, same signature and return shape (both DatabaseProviders
-- keep calling it unchanged):
--   1. The pool counts only `source = 'studio'`.
--   2. A non-studio reservation skips the limit but still upserts its row.
--      The row is not optional: the turn-end settle
--      (`increment_agent_usage_tokens_v3`) only UPDATEs, so without it the
--      turn's tokens are never recorded, and the usage panel reads the
--      BYOA count from it.
--
-- Reverting to 027's body restores the old behavior exactly; no data is
-- touched here.

CREATE OR REPLACE FUNCTION public.increment_agent_usage_if_allowed(
  p_workspace_id uuid,
  p_user_id uuid,
  p_api_key_id uuid DEFAULT NULL::uuid,
  p_month text DEFAULT ''::text,
  p_source text DEFAULT 'studio'::text,
  p_limit integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_current INTEGER;
BEGIN
  -- Serialize concurrent reservations for the same workspace+month
  PERFORM pg_advisory_xact_lock(
    hashtext(p_workspace_id::text || ':agent:' || p_month)
  );

  -- Workspace total of Studio-funded credits across every user
  SELECT COALESCE(SUM(message_count), 0) INTO v_current
  FROM public.agent_usage
  WHERE workspace_id = p_workspace_id
    AND month = p_month
    AND source = 'studio';

  IF p_source = 'studio' AND v_current >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'current_count', v_current);
  END IF;

  -- Reserve: atomic upsert +1 on the caller's own row
  INSERT INTO public.agent_usage (
    workspace_id, user_id, api_key_id, month, source,
    message_count, input_tokens, output_tokens
  )
  VALUES (
    p_workspace_id, p_user_id, p_api_key_id, p_month, p_source,
    1, 0, 0
  )
  ON CONFLICT (workspace_id, user_id, month, source) DO UPDATE SET
    message_count = public.agent_usage.message_count + 1,
    updated_at = now();

  RETURN jsonb_build_object(
    'allowed', true,
    'current_count', CASE WHEN p_source = 'studio' THEN v_current + 1 ELSE v_current END
  );
END;
$$;
