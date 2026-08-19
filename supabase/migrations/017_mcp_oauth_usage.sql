-- Remote MCP (OAuth) usage accounting — SHARED lineage (both pairs).
--
-- The OAuth remote endpoint (/api/mcp/remote) cannot account through
-- mcp_cloud_usage: that table's mcp_key_id is part of the PRIMARY KEY and
-- FK-bound to mcp_cloud_keys(id), and OAuth grants have no key row. It gets
-- its own per-grant table instead — and BOTH monthly-quota functions now
-- check the COMBINED total, so the API-key surface and the OAuth surface
-- share one `api.mcp_calls_per_month` pool (otherwise a workspace could
-- spend the quota twice by splitting traffic across surfaces).
--
-- grant_id is a bare uuid ON PURPOSE: auth.oauth_grants exists only on the
-- managed pair (postgres/migrations/016), and this shared migration must
-- apply cleanly on the Supabase pair too (schema stays in core). The
-- Supabase pair simply never writes here.

CREATE TABLE public.mcp_oauth_usage (
    workspace_id uuid NOT NULL,
    month text NOT NULL,
    grant_id uuid NOT NULL,
    call_count integer DEFAULT 0 NOT NULL,
    last_call_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.mcp_oauth_usage
    ADD CONSTRAINT mcp_oauth_usage_pkey PRIMARY KEY (workspace_id, month, grant_id);

ALTER TABLE ONLY public.mcp_oauth_usage
    ADD CONSTRAINT mcp_oauth_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

-- RLS parity with mcp_cloud_usage.
ALTER TABLE public.mcp_oauth_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage mcp oauth usage" ON public.mcp_oauth_usage USING (true);

CREATE POLICY "Workspace members can view mcp oauth usage" ON public.mcp_oauth_usage FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));

-- Combined monthly total across both MCP surfaces.
CREATE FUNCTION public.workspace_mcp_month_total(p_workspace_id uuid, p_month text) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT COALESCE((SELECT SUM(call_count) FROM public.mcp_cloud_usage
                    WHERE workspace_id = p_workspace_id AND month = p_month), 0)::integer
       + COALESCE((SELECT SUM(call_count) FROM public.mcp_oauth_usage
                    WHERE workspace_id = p_workspace_id AND month = p_month), 0)::integer
$$;

-- BEHAVIOR CHANGE for the key surface: the quota check now counts OAuth
-- usage too (single combined pool). Body otherwise identical to 001.
CREATE OR REPLACE FUNCTION public.increment_mcp_cloud_usage_if_allowed(p_workspace_id uuid, p_month text, p_key_id uuid, p_limit integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_current INTEGER;
BEGIN
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

-- OAuth-surface twin: same combined-pool check, upserts the per-grant row.
CREATE FUNCTION public.increment_mcp_oauth_usage_if_allowed(p_workspace_id uuid, p_month text, p_grant_id uuid, p_limit integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_current INTEGER;
BEGIN
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
