-- Phase 3: CDN Content Delivery
-- cdn_api_keys, cdn_builds, cdn_usage + project CDN columns

-- ============================================================
-- PROJECT CDN COLUMNS
-- ============================================================

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS cdn_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS cdn_branch TEXT; -- null = default_branch

-- ============================================================
-- CDN API KEYS
-- Per-project API keys for CDN access. Key stored as SHA-256 hash.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cdn_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix VARCHAR(16) NOT NULL,
  name TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'preview')),
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 1000,
  allowed_origins TEXT[],
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

-- Index for key lookup (hot path — every CDN request)
CREATE INDEX IF NOT EXISTS idx_cdn_api_keys_hash ON public.cdn_api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cdn_api_keys_project ON public.cdn_api_keys(project_id);

-- ============================================================
-- CDN BUILDS
-- Track build history and status.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cdn_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL DEFAULT 'webhook'
    CHECK (trigger_type IN ('webhook', 'manual', 'api')),
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'building', 'success', 'failed')),
  content_hash TEXT,
  file_count INTEGER,
  total_size_bytes BIGINT,
  changed_models TEXT[],
  build_duration_ms INTEGER,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cdn_builds_project_status ON public.cdn_builds(project_id, status, started_at DESC);

-- ============================================================
-- CDN USAGE
-- Daily aggregation per project per key. Written by EE metering.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cdn_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES public.cdn_api_keys(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0,
  bandwidth_bytes BIGINT NOT NULL DEFAULT 0,
  UNIQUE(project_id, api_key_id, period_start)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.cdn_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cdn_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cdn_usage ENABLE ROW LEVEL SECURITY;

-- cdn_api_keys: workspace owner/admin can manage
CREATE POLICY "Workspace owner/admin can manage CDN keys"
  ON public.cdn_api_keys FOR ALL
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

-- cdn_builds: workspace members can view
CREATE POLICY "Workspace members can view CDN builds"
  ON public.cdn_builds FOR SELECT
  USING (project_id IN (
    SELECT p.id FROM public.projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  ));

-- cdn_builds: system inserts (admin client only, no user RLS needed for insert)

-- cdn_usage: workspace owner/admin can view
CREATE POLICY "Workspace owner/admin can view CDN usage"
  ON public.cdn_usage FOR SELECT
  USING (project_id IN (
    SELECT p.id FROM public.projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
  ));
