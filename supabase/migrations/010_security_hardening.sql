-- Fix search_path mutable warnings on trigger functions
-- Prevents schema injection attacks by locking search_path

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ws_id uuid;
  ws_slug text;
BEGIN
  INSERT INTO public.profiles (id, display_name, email, avatar_url)
  VALUES (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    new.email,
    new.raw_user_meta_data ->> 'avatar_url'
  );

  ws_slug := lower(regexp_replace(
    coalesce(
      new.raw_user_meta_data ->> 'user_name',
      new.raw_user_meta_data ->> 'preferred_username',
      split_part(new.email, '@', 1)
    ),
    '[^a-z0-9-]', '-', 'g'
  )) || '-' || substr(new.id::text, 1, 8);

  ws_id := gen_random_uuid();
  INSERT INTO public.workspaces (id, name, slug, type, owner_id)
  VALUES (
    ws_id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ) || '''s Workspace',
    ws_slug,
    'primary',
    new.id
  );

  RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.workspace_members (workspace_id, user_id, role, accepted_at)
  VALUES (new.id, new.owner_id, 'owner', now());
  RETURN new;
END;
$$;

-- Tighten RLS policies: restrict INSERT/UPDATE/DELETE to authenticated users only
-- (service_role bypasses RLS entirely, so these policies only affect anon/authenticated)

-- cdn_builds: only workspace members can insert/update
DROP POLICY IF EXISTS "Authenticated users can insert CDN builds" ON public.cdn_builds;
CREATE POLICY "Workspace members can insert CDN builds"
  ON public.cdn_builds FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
      WHERE p.id = cdn_builds.project_id
      AND wm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "System can update CDN builds" ON public.cdn_builds;
CREATE POLICY "Workspace members can update CDN builds"
  ON public.cdn_builds FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
      WHERE p.id = cdn_builds.project_id
      AND wm.user_id = auth.uid()
    )
  );

-- form_submissions: server-only via admin client (restrict to service_role)
-- Drop permissive policies, replace with restrictive ones that block anon/authenticated
DROP POLICY IF EXISTS "Service role can insert form submissions" ON public.form_submissions;
DROP POLICY IF EXISTS "Service role can update form submissions" ON public.form_submissions;
DROP POLICY IF EXISTS "Service role can delete form submissions" ON public.form_submissions;

-- Only workspace owner/admin can manage submissions (via authenticated client)
CREATE POLICY "Workspace admin can insert form submissions"
  ON public.form_submissions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = form_submissions.workspace_id
      AND wm.user_id = auth.uid()
      AND wm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "Workspace admin can update form submissions"
  ON public.form_submissions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = form_submissions.workspace_id
      AND wm.user_id = auth.uid()
      AND wm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "Workspace admin can delete form submissions"
  ON public.form_submissions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = form_submissions.workspace_id
      AND wm.user_id = auth.uid()
      AND wm.role IN ('owner', 'admin')
    )
  );

-- media_assets: only workspace members can insert
DROP POLICY IF EXISTS "Authenticated users can insert media assets" ON public.media_assets;
CREATE POLICY "Workspace members can insert media assets"
  ON public.media_assets FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = media_assets.workspace_id
      AND wm.user_id = auth.uid()
    )
  );

-- media_usage: only workspace members can manage
DROP POLICY IF EXISTS "System can manage media usage" ON public.media_usage;
CREATE POLICY "Workspace members can manage media usage"
  ON public.media_usage FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.media_assets ma
      JOIN public.workspace_members wm ON wm.workspace_id = ma.workspace_id
      WHERE ma.id = media_usage.asset_id
      AND wm.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.media_assets ma
      JOIN public.workspace_members wm ON wm.workspace_id = ma.workspace_id
      WHERE ma.id = media_usage.asset_id
      AND wm.user_id = auth.uid()
    )
  );
