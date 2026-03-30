-- Conversation API keys + Webhook Outbound
-- Business+ features: external AI content ops API + event delivery

-- ============================================================
-- CONVERSATION API KEYS
-- Bearer token authentication for external API access.
-- Key format: crn_conv_{base62} — stored as SHA-256 hash.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.conversation_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Key identity (plaintext never stored)
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,

  -- Permissions
  role TEXT NOT NULL DEFAULT 'editor'
    CHECK (role IN ('viewer', 'editor', 'admin')),
  specific_models BOOLEAN NOT NULL DEFAULT false,
  allowed_models TEXT[] DEFAULT ARRAY[]::TEXT[],
  allowed_tools TEXT[] DEFAULT ARRAY[]::TEXT[],
  allowed_locales TEXT[] DEFAULT ARRAY[]::TEXT[],

  -- Customization
  custom_instructions TEXT,
  ai_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',

  -- Limits
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 10,
  monthly_message_limit INTEGER NOT NULL DEFAULT 1000,

  -- Tracking
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_conv_keys_project ON public.conversation_api_keys(project_id);
CREATE INDEX idx_conv_keys_hash ON public.conversation_api_keys(key_hash);

-- RLS
ALTER TABLE public.conversation_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view conversation keys"
  ON public.conversation_api_keys FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role can manage conversation keys"
  ON public.conversation_api_keys FOR ALL
  USING (true);

-- Track API key usage in agent_usage
ALTER TABLE public.agent_usage
  ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES public.conversation_api_keys(id);

-- ============================================================
-- WEBHOOKS
-- Outbound event delivery to external URLs.
-- HMAC-SHA256 signed, exponential backoff retry.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  secret TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhooks_project ON public.webhooks(project_id);

ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view webhooks"
  ON public.webhooks FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role can manage webhooks"
  ON public.webhooks FOR ALL
  USING (true);

-- ============================================================
-- WEBHOOK DELIVERIES
-- Tracks each delivery attempt with status and retry info.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES public.webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  response_code INTEGER,
  response_body TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_deliveries_webhook ON public.webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_pending ON public.webhook_deliveries(status, next_retry_at)
  WHERE status = 'pending';

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- Deliveries visible to workspace members (via webhook → workspace join)
CREATE POLICY "Workspace members can view webhook deliveries"
  ON public.webhook_deliveries FOR SELECT
  USING (
    webhook_id IN (
      SELECT w.id FROM public.webhooks w
      WHERE w.workspace_id IN (
        SELECT wm.workspace_id FROM public.workspace_members wm
        WHERE wm.user_id = auth.uid()
      )
    )
  );

-- Service role manages deliveries (insert/update from webhook engine)
CREATE POLICY "Service role can manage webhook deliveries"
  ON public.webhook_deliveries FOR ALL
  USING (true);
