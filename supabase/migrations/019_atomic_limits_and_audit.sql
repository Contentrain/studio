-- Atomic limit-check RPCs for workspace members, CDN keys, and storage quota.
-- Closes race conditions where concurrent requests can exceed plan limits
-- via check-then-insert patterns.

-- ============================================================
-- 1. create_workspace_member_if_allowed
--    Atomically checks workspace seat limit and inserts a member.
--    Uses advisory lock to serialize concurrent additions per workspace.
--    Handles unique(workspace_id, user_id) via ON CONFLICT — idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_workspace_member_if_allowed(
  p_workspace_id UUID,
  p_member_user_id UUID,
  p_role TEXT,
  p_invited_email TEXT,
  p_accepted_at TIMESTAMPTZ DEFAULT NULL,
  p_limit INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
  v_member_id UUID;
  v_existing_id UUID;
BEGIN
  -- Serialize concurrent member additions for same workspace
  PERFORM pg_advisory_xact_lock(
    hashtext('wm:' || p_workspace_id::text)
  );

  -- Check if user is already a member (unique constraint: workspace_id, user_id)
  SELECT id INTO v_existing_id
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id
    AND user_id = p_member_user_id;

  IF v_existing_id IS NOT NULL THEN
    -- Already a member — return success without consuming a seat
    RETURN jsonb_build_object(
      'allowed', true,
      'current_count', (SELECT COUNT(*) FROM public.workspace_members WHERE workspace_id = p_workspace_id),
      'member_id', v_existing_id,
      'already_existed', true
    );
  END IF;

  -- Count current members
  SELECT COUNT(*) INTO v_count
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id;

  -- Reject if at or over limit
  IF v_count >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'current_count', v_count);
  END IF;

  -- Insert the new member
  INSERT INTO public.workspace_members (
    workspace_id, user_id, role, invited_email, accepted_at
  )
  VALUES (
    p_workspace_id, p_member_user_id, p_role, p_invited_email, p_accepted_at
  )
  RETURNING id INTO v_member_id;

  RETURN jsonb_build_object(
    'allowed', true,
    'current_count', v_count + 1,
    'member_id', v_member_id,
    'already_existed', false
  );
END;
$$;

-- ============================================================
-- 2. create_cdn_key_if_allowed
--    Atomically checks active CDN key count and inserts a new key.
--    Uses advisory lock to serialize concurrent key creation per project.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_cdn_key_if_allowed(
  p_project_id UUID,
  p_workspace_id UUID,
  p_key_hash TEXT,
  p_key_prefix VARCHAR,
  p_name TEXT,
  p_limit INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
  v_key public.cdn_api_keys;
BEGIN
  -- Serialize concurrent key creation for same project
  PERFORM pg_advisory_xact_lock(
    hashtext('cdn:' || p_project_id::text)
  );

  -- Count active (non-revoked) keys
  SELECT COUNT(*) INTO v_count
  FROM public.cdn_api_keys
  WHERE project_id = p_project_id
    AND revoked_at IS NULL;

  -- Reject if at or over limit
  IF v_count >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'current_count', v_count);
  END IF;

  -- Insert the new key
  INSERT INTO public.cdn_api_keys (
    project_id, workspace_id, key_hash, key_prefix, name
  )
  VALUES (
    p_project_id, p_workspace_id, p_key_hash, p_key_prefix, p_name
  )
  RETURNING * INTO v_key;

  RETURN jsonb_build_object(
    'allowed', true,
    'current_count', v_count + 1,
    'key', jsonb_build_object(
      'id', v_key.id,
      'name', v_key.name,
      'key_prefix', v_key.key_prefix,
      'environment', v_key.environment,
      'created_at', v_key.created_at
    )
  );
END;
$$;

-- ============================================================
-- 3. reserve_storage_if_allowed
--    Atomically checks workspace storage quota and reserves bytes.
--    Uses advisory lock to serialize concurrent uploads per workspace.
--    Caller must adjust or rollback after upload completes/fails.
-- ============================================================

CREATE OR REPLACE FUNCTION public.reserve_storage_if_allowed(
  p_workspace_id UUID,
  p_reserve_bytes BIGINT,
  p_limit_bytes BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current BIGINT;
BEGIN
  -- Serialize concurrent uploads for same workspace
  PERFORM pg_advisory_xact_lock(
    hashtext('storage:' || p_workspace_id::text)
  );

  -- Get current usage
  SELECT COALESCE(media_storage_bytes, 0) INTO v_current
  FROM public.workspaces
  WHERE id = p_workspace_id;

  -- Reject if reservation would exceed limit
  IF p_limit_bytes > 0 AND v_current + p_reserve_bytes > p_limit_bytes THEN
    RETURN jsonb_build_object('allowed', false, 'current_bytes', v_current);
  END IF;

  -- Reserve: atomically increment storage counter
  UPDATE public.workspaces
  SET media_storage_bytes = v_current + p_reserve_bytes
  WHERE id = p_workspace_id;

  RETURN jsonb_build_object('allowed', true, 'current_bytes', v_current + p_reserve_bytes);
END;
$$;
