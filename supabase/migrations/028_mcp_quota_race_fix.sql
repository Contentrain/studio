-- MCP Cloud / OAuth quota race fix (SS-14).
--
-- Both `increment_mcp_cloud_usage_if_allowed` (017) and its OAuth twin
-- `increment_mcp_oauth_usage_if_allowed` check the combined workspace
-- total (`workspace_mcp_month_total`, summing both surfaces) with a plain
-- SELECT, then upsert — classic check-then-act. Two concurrent calls near
-- the limit (the realistic case here: MCP callers are automated agents,
-- not humans typing one message at a time) can both read the same
-- under-limit count and both proceed, overshooting the cap by more than
-- one call. `increment_agent_usage_if_allowed` (027) closed the same race
-- for AI credits with a per-key advisory lock; this applies the identical
-- fix here. The lock key is workspace+month (not per mcp_key_id/grant_id)
-- because the pool it guards is combined across both surfaces.
--
-- Bodies are otherwise byte-identical to 017.

CREATE OR REPLACE FUNCTION public.increment_mcp_cloud_usage_if_allowed(p_workspace_id uuid, p_month text, p_key_id uuid, p_limit integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_current INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_workspace_id::text || ':mcp:' || p_month)
  );

  v_current := public.workspace_mcp_month_total(p_workspace_id, p_month);

  IF p_limit IS NOT NULL AND v_current >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'used', v_current);
  END IF;

  INSERT INTO public.mcp_cloud_usage (workspace_id, month, mcp_key_id, call_count, last_call_at)
  VALUES (p_workspace_id, p_month, p_key_id, 1, now())
  ON CONFLICT (workspace_id, month, mcp_key_id)
  DO UPDATE SET
    call_count = public.mcp_cloud_usage.call_count + 1,
    last_call_at = now();

  RETURN jsonb_build_object('allowed', true, 'used', v_current + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_mcp_oauth_usage_if_allowed(p_workspace_id uuid, p_month text, p_grant_id uuid, p_limit integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_current INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_workspace_id::text || ':mcp:' || p_month)
  );

  v_current := public.workspace_mcp_month_total(p_workspace_id, p_month);

  IF p_limit IS NOT NULL AND v_current >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'used', v_current);
  END IF;

  INSERT INTO public.mcp_oauth_usage (workspace_id, month, grant_id, call_count, last_call_at)
  VALUES (p_workspace_id, p_month, p_grant_id, 1, now())
  ON CONFLICT (workspace_id, month, grant_id)
  DO UPDATE SET
    call_count = public.mcp_oauth_usage.call_count + 1,
    last_call_at = now();

  RETURN jsonb_build_object('allowed', true, 'used', v_current + 1);
END;
$$;
