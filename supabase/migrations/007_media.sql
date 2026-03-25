-- Phase 4: Media Management
-- media_assets, media_usage + workspace storage tracking

-- ============================================================
-- WORKSPACE STORAGE TRACKING
-- ============================================================

ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS media_storage_bytes BIGINT NOT NULL DEFAULT 0;

-- ============================================================
-- MEDIA ASSETS
-- Per-project binary asset metadata. Binaries live in R2.
-- Hybrid sync: core metadata in git (_media model), enriched data here.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- File info
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  content_hash TEXT NOT NULL,

  -- Image/video metadata (enriched — not stored in git)
  width INTEGER,
  height INTEGER,
  format TEXT NOT NULL,
  blurhash TEXT,
  focal_point JSONB,
  duration_seconds NUMERIC,

  -- User metadata (synced to git)
  alt TEXT,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],

  -- Storage paths (relative to project R2 prefix)
  original_path TEXT NOT NULL,
  variants JSONB NOT NULL DEFAULT '{}',

  -- Tracking
  uploaded_by UUID NOT NULL REFERENCES public.profiles(id),
  source TEXT NOT NULL DEFAULT 'upload'
    CHECK (source IN ('upload', 'url', 'connector', 'agent')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_project ON public.media_assets(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_assets_hash ON public.media_assets(project_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_media_assets_tags ON public.media_assets USING gin(tags);

-- ============================================================
-- MEDIA USAGE TRACKING
-- Which content entries reference which assets.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.media_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(asset_id, model_id, entry_id, field_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_media_usage_asset ON public.media_usage(asset_id);
CREATE INDEX IF NOT EXISTS idx_media_usage_entry ON public.media_usage(model_id, entry_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_usage ENABLE ROW LEVEL SECURITY;

-- media_assets: workspace members can view
CREATE POLICY "Workspace members can view media assets"
  ON public.media_assets FOR SELECT
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = auth.uid()
  ));

-- media_assets: upload via admin client after server-side permission check
CREATE POLICY "Authenticated users can insert media assets"
  ON public.media_assets FOR INSERT
  WITH CHECK (true);

-- media_assets: owner/admin can update metadata
CREATE POLICY "Owner/Admin can update media assets"
  ON public.media_assets FOR UPDATE
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

-- media_assets: owner/admin can delete
CREATE POLICY "Owner/Admin can delete media assets"
  ON public.media_assets FOR DELETE
  USING (workspace_id IN (
    SELECT workspace_id FROM public.workspace_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

-- media_usage: workspace members can view
CREATE POLICY "Workspace members can view media usage"
  ON public.media_usage FOR SELECT
  USING (project_id IN (
    SELECT p.id FROM public.projects p
    JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  ));

-- media_usage: system-managed (insert/delete via admin client)
CREATE POLICY "System can manage media usage"
  ON public.media_usage FOR ALL
  USING (true);
