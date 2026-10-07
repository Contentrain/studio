-- Delete-safe creator FK on MCP Cloud keys (B107).
--
-- mcp_cloud_keys.created_by → profiles(id) was left with NO ACTION in the
-- baseline (migration 015 fixed form_submissions.approved_by and
-- media_assets.uploaded_by but missed this one). A key outlives its creator:
-- ownership of a workspace gets transferred and the key stays with the
-- workspace, so deleting the former creator's account (GDPR erasure,
-- auth.users → profiles cascade) failed with
--   update or delete on table "profiles" violates foreign key constraint
--   "mcp_cloud_keys_created_by_fkey"
-- and DELETE /api/profile answered 500.
--
-- created_by is an audit/creator stamp, not ownership: the key belongs to the
-- workspace/project. The row stays and the creator reads as "deleted user"
-- (NULL), same as approved_by / uploaded_by. The column is already nullable.
--
-- Audit (all FKs to public.profiles and auth.users, both runners share this
-- one lineage): every other action is CASCADE (rows that belong to the user:
-- memberships, owned workspaces, keys, usage, grants, tokens) or SET NULL
-- (comments, reviews, approvals, media jobs, form approvals, uploads).

ALTER TABLE public.mcp_cloud_keys
  DROP CONSTRAINT IF EXISTS mcp_cloud_keys_created_by_fkey;
ALTER TABLE public.mcp_cloud_keys
  ADD CONSTRAINT mcp_cloud_keys_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
