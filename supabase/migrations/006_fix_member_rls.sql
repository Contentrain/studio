-- Fix: workspace_members RLS policies to allow admin (not just owner) for mutations
-- Routes already check owner/admin role, but RLS was owner-only

-- Drop existing mutation policies
DROP POLICY IF EXISTS "Workspace owner can manage members" ON public.workspace_members;

-- Recreate with owner + admin
CREATE POLICY "Workspace owner/admin can manage members"
  ON public.workspace_members FOR ALL
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
    )
  );

-- Also fix: members can view all members in their workspace (not just own row)
DROP POLICY IF EXISTS "Users can view own workspace memberships" ON public.workspace_members;

CREATE POLICY "Workspace members can view all members"
  ON public.workspace_members FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );
