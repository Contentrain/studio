-- Fix: RLS recursion — terminal policies only, zero cross-table recursion
-- NEVER query workspace_members from workspace_members OR workspaces policies

-- Drop ALL existing workspace_members policies
DROP POLICY IF EXISTS "Workspace owner can manage members" ON public.workspace_members;
DROP POLICY IF EXISTS "Workspace owner/admin can manage members" ON public.workspace_members;
DROP POLICY IF EXISTS "Users can view own workspace memberships" ON public.workspace_members;
DROP POLICY IF EXISTS "Workspace members can view all members" ON public.workspace_members;
DROP POLICY IF EXISTS "wm_select_members" ON public.workspace_members;
DROP POLICY IF EXISTS "wm_manage_members" ON public.workspace_members;
DROP POLICY IF EXISTS "wm_select_own" ON public.workspace_members;
DROP POLICY IF EXISTS "wm_owner_manage" ON public.workspace_members;

-- Also fix workspaces SELECT policy (was querying workspace_members → recursion)
DROP POLICY IF EXISTS "Members can view workspaces" ON public.workspaces;

CREATE POLICY "Members can view workspaces"
  ON public.workspaces FOR SELECT
  USING (owner_id = auth.uid());

-- NOTE: Non-owner workspace access is handled via two-step query in db.ts
-- (workspace_members → workspace IDs → workspaces by ID)

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
