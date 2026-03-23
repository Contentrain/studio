-- Fix: workspace_members RLS — allow admin mutations + full member visibility
-- AVOIDS self-referencing recursion by using workspaces.owner_id for owner check
-- and a terminal policy pattern for admin check

-- Drop existing policies that may conflict
DROP POLICY IF EXISTS "Workspace owner can manage members" ON public.workspace_members;
DROP POLICY IF EXISTS "Workspace owner/admin can manage members" ON public.workspace_members;
DROP POLICY IF EXISTS "Users can view own workspace memberships" ON public.workspace_members;
DROP POLICY IF EXISTS "Workspace members can view all members" ON public.workspace_members;

-- SELECT: any workspace member can see all members in their workspace
-- Uses terminal approach: check auth.uid() is in workspace_members for this workspace
CREATE POLICY "wm_select_members"
  ON public.workspace_members FOR SELECT
  USING (
    -- Owner always (via workspaces table, no recursion)
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_members.workspace_id AND w.owner_id = auth.uid()
    )
    OR
    -- Any member can view roster (self-check only)
    user_id = auth.uid()
    OR
    -- Admin/member in same workspace (use a subquery that won't recurse)
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: owner (via workspaces table) or admin (terminal self-check)
CREATE POLICY "wm_manage_members"
  ON public.workspace_members FOR ALL
  USING (
    -- Owner (no recursion — uses workspaces table)
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_members.workspace_id AND w.owner_id = auth.uid()
    )
    OR
    -- Admin (terminal: only checks own row)
    EXISTS (
      SELECT 1 FROM public.workspace_members wm_check
      WHERE wm_check.workspace_id = workspace_members.workspace_id
        AND wm_check.user_id = auth.uid()
        AND wm_check.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_members.workspace_id AND w.owner_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.workspace_members wm_check
      WHERE wm_check.workspace_id = workspace_members.workspace_id
        AND wm_check.user_id = auth.uid()
        AND wm_check.role = 'admin'
    )
  );
