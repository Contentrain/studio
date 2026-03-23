-- Fix: workspace_members RLS — terminal policies only, zero recursion
-- NEVER query workspace_members from inside workspace_members policy

-- Drop ALL existing workspace_members policies
DROP POLICY IF EXISTS "Workspace owner can manage members" ON public.workspace_members;
DROP POLICY IF EXISTS "Workspace owner/admin can manage members" ON public.workspace_members;
DROP POLICY IF EXISTS "Users can view own workspace memberships" ON public.workspace_members;
DROP POLICY IF EXISTS "Workspace members can view all members" ON public.workspace_members;
DROP POLICY IF EXISTS "wm_select_members" ON public.workspace_members;
DROP POLICY IF EXISTS "wm_manage_members" ON public.workspace_members;
DROP POLICY IF EXISTS "wm_select_own" ON public.workspace_members;
DROP POLICY IF EXISTS "wm_owner_manage" ON public.workspace_members;

-- SELECT: user sees own membership row only (terminal, no recursion)
-- Full roster listing is done via admin client in the API layer
CREATE POLICY "wm_select_own"
  ON public.workspace_members FOR SELECT
  USING (user_id = auth.uid());

-- INSERT/UPDATE/DELETE: workspace owner only (via workspaces table, no recursion)
-- Admin mutations are done via admin client in the API layer
CREATE POLICY "wm_owner_manage"
  ON public.workspace_members FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_members.workspace_id
        AND w.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_members.workspace_id
        AND w.owner_id = auth.uid()
    )
  );
