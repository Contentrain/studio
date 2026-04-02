-- Atomic limit-check RPC functions
-- Prevents race conditions on monthly usage counters (chat messages, form submissions)
-- and deploys previously-called-but-missing increment RPCs (storage, CDN).

-- ============================================================
-- 1. increment_agent_usage_if_allowed
--    Atomically checks monthly message limit and reserves a slot.
--    Uses advisory lock to serialize concurrent requests for
--    the same workspace + user + month.
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_agent_usage_if_allowed(
  p_workspace_id UUID,
  p_user_id UUID,
  p_api_key_id UUID DEFAULT NULL,
  p_month TEXT DEFAULT '',
  p_source TEXT DEFAULT 'studio',
  p_limit INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current INTEGER;
BEGIN
  -- Serialize concurrent requests for same workspace+user+month
  PERFORM pg_advisory_xact_lock(
    hashtext(p_workspace_id::text || ':' || p_user_id::text || ':' || p_month)
  );

  -- Sum usage across all sources for this workspace+user+month
  SELECT COALESCE(SUM(message_count), 0) INTO v_current
  FROM public.agent_usage
  WHERE workspace_id = p_workspace_id
    AND user_id = p_user_id
    AND month = p_month;

  -- Reject if at or over limit
  IF v_current >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'current_count', v_current);
  END IF;

  -- Reserve: atomic upsert +1 message
  INSERT INTO public.agent_usage (
    workspace_id, user_id, api_key_id, month, source,
    message_count, input_tokens, output_tokens
  )
  VALUES (
    p_workspace_id, p_user_id, p_api_key_id, p_month, p_source,
    1, 0, 0
  )
  ON CONFLICT (workspace_id, user_id, month, source) DO UPDATE SET
    message_count = public.agent_usage.message_count + 1,
    updated_at = now();

  RETURN jsonb_build_object('allowed', true, 'current_count', v_current + 1);
END;
$$;

-- ============================================================
-- 2. create_form_submission_if_allowed
--    Atomically checks monthly submission limit and inserts
--    the submission in one operation.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_form_submission_if_allowed(
  p_workspace_id UUID,
  p_monthly_limit INTEGER,
  p_project_id UUID,
  p_model_id TEXT,
  p_data JSONB,
  p_status TEXT DEFAULT 'pending',
  p_source_ip INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_locale TEXT DEFAULT 'en'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
  v_submission public.form_submissions;
BEGIN
  -- Serialize concurrent submissions for same workspace
  PERFORM pg_advisory_xact_lock(
    hashtext('fs:' || p_workspace_id::text)
  );

  -- Count current month's submissions
  SELECT COUNT(*) INTO v_count
  FROM public.form_submissions
  WHERE workspace_id = p_workspace_id
    AND created_at >= date_trunc('month', now())
    AND created_at < date_trunc('month', now()) + interval '1 month';

  -- Reject if at or over limit
  IF v_count >= p_monthly_limit THEN
    RETURN jsonb_build_object('allowed', false, 'current_count', v_count);
  END IF;

  -- Insert the submission
  INSERT INTO public.form_submissions (
    project_id, workspace_id, model_id, data, status,
    source_ip, user_agent, referrer, locale
  )
  VALUES (
    p_project_id, p_workspace_id, p_model_id, p_data, p_status,
    p_source_ip, p_user_agent, p_referrer, p_locale
  )
  RETURNING * INTO v_submission;

  RETURN jsonb_build_object(
    'allowed', true,
    'current_count', v_count + 1,
    'submission', to_jsonb(v_submission)
  );
END;
$$;

-- ============================================================
-- 2b. increment_agent_usage_tokens
--     Atomically increments token counters on an existing usage row.
--     Prevents concurrent chat completions from overwriting each other.
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_agent_usage_tokens(
  p_workspace_id UUID,
  p_user_id UUID,
  p_month TEXT,
  p_source TEXT,
  p_input_tokens BIGINT,
  p_output_tokens BIGINT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.agent_usage
  SET
    input_tokens = input_tokens + p_input_tokens,
    output_tokens = output_tokens + p_output_tokens,
    updated_at = now()
  WHERE workspace_id = p_workspace_id
    AND user_id = p_user_id
    AND month = p_month
    AND source = p_source;
END;
$$;

-- ============================================================
-- 3. increment_storage_bytes
--    Already called by app code (with fallback). Deploy the
--    actual RPC so the fallback read+write path is never used.
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_storage_bytes(
  p_workspace_id UUID,
  p_delta BIGINT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.workspaces
  SET media_storage_bytes = GREATEST(0, media_storage_bytes + p_delta)
  WHERE id = p_workspace_id;
END;
$$;

-- ============================================================
-- 4. increment_cdn_usage
--    Already called by app code (with fallback). Deploy the
--    actual RPC so the fallback read+write path is never used.
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_cdn_usage(
  p_project_id UUID,
  p_api_key_id UUID,
  p_period_start DATE,
  p_request_count BIGINT,
  p_bandwidth_bytes BIGINT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.cdn_usage (
    project_id, api_key_id, period_start,
    request_count, bandwidth_bytes
  )
  VALUES (
    p_project_id, p_api_key_id, p_period_start,
    p_request_count, p_bandwidth_bytes
  )
  ON CONFLICT (project_id, api_key_id, period_start) DO UPDATE SET
    request_count = public.cdn_usage.request_count + p_request_count,
    bandwidth_bytes = public.cdn_usage.bandwidth_bytes + p_bandwidth_bytes;
END;
$$;
