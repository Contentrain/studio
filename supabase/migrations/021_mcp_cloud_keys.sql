-- MCP Cloud API keys
--
-- Bearer token authentication for the hosted MCP HTTP endpoint.
-- Key format: crn_mcp_{base62} — plaintext is never stored; only the
-- SHA-256 hash and the first eight plaintext characters (prefix) for
-- display purposes are kept.
--
-- Conceptually parallel to conversation_api_keys but tracks a different
-- SKU (raw tool execution, bring-your-own-AI) with its own quota meter
-- (api.mcp_calls_per_month). The two tables deliberately stay separate
-- so:
--
--   - schemas stay strongly typed (no nullable AI-specific fields)
--   - quota / overage counters are trivially isolated per SKU
--   - audit event shapes stay discriminated (conversation_key.* vs
--     mcp_cloud_key.*)
--   - future key kinds (CLI tokens, SDK tokens) can be added without
--     forcing a shared denormalised table

CREATE TABLE IF NOT EXISTS public.mcp_cloud_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Key identity (plaintext never stored)
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,

  -- Scope
  allowed_tools TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Limits
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60,
  monthly_call_limit INTEGER,

  -- Tracking
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.profiles(id),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_cloud_keys_workspace
  ON public.mcp_cloud_keys(workspace_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_cloud_keys_project
  ON public.mcp_cloud_keys(project_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_cloud_keys_hash
  ON public.mcp_cloud_keys(key_hash);

ALTER TABLE public.mcp_cloud_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view mcp cloud keys"
  ON public.mcp_cloud_keys FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role can manage mcp cloud keys"
  ON public.mcp_cloud_keys FOR ALL
  USING (true);

-- Separate monthly call meter — mcp_cloud usage never counts toward
-- api.messages_per_month (conversation API) and vice versa.
CREATE TABLE IF NOT EXISTS public.mcp_cloud_usage (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                     -- YYYY-MM
  mcp_key_id UUID REFERENCES public.mcp_cloud_keys(id) ON DELETE SET NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  last_call_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month, mcp_key_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_cloud_usage_ws_month
  ON public.mcp_cloud_usage(workspace_id, month);

ALTER TABLE public.mcp_cloud_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view mcp cloud usage"
  ON public.mcp_cloud_usage FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role can manage mcp cloud usage"
  ON public.mcp_cloud_usage FOR ALL
  USING (true);

-- Atomic increment-if-allowed RPC — mirrors increment_agent_usage_if_allowed
-- for the conversation API. Returns JSONB { allowed: boolean, used: int }
-- so the endpoint can reject calls past the monthly limit without a race.
CREATE OR REPLACE FUNCTION public.increment_mcp_cloud_usage_if_allowed(
  p_workspace_id UUID,
  p_month TEXT,
  p_key_id UUID,
  p_limit INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current INTEGER;
BEGIN
  SELECT COALESCE(SUM(call_count), 0)
    INTO v_current
    FROM public.mcp_cloud_usage
   WHERE workspace_id = p_workspace_id
     AND month = p_month;

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
