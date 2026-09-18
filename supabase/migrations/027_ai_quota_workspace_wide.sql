-- 027: the AI credit quota is a workspace quota.
--
-- `ai.messages_per_month` is sold per workspace, the billing dashboard
-- sums `agent_usage` per workspace, and the API quota
-- (`increment_api_usage_if_allowed`, 006) already caps the workspace
-- total. The chat reservation did not: it summed only the calling
-- user's rows, so every member of a workspace got the full plan limit
-- on their own and a four-person Pro workspace could spend 4 x 1500
-- credits before anything was refused.
--
-- Same signature and return shape, so both DatabaseProviders keep
-- calling it unchanged. The sum now spans every user and source of the
-- workspace for the month, and the advisory lock is taken per
-- workspace+month so two members racing for the last credit are
-- serialised the same way two tabs of one member always were. Rows are
-- still booked per user (the unique key and the revert are untouched),
-- so per-user reporting keeps working.
--
-- OR REPLACE: replaces the 001 definition in place; grants carry over.

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

  -- Workspace total across every user and source for the month
  SELECT COALESCE(SUM(message_count), 0) INTO v_current
  FROM public.agent_usage
  WHERE workspace_id = p_workspace_id
    AND month = p_month;

  IF v_current >= p_limit THEN
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

  RETURN jsonb_build_object('allowed', true, 'current_count', v_current + 1);
END;
$$;
