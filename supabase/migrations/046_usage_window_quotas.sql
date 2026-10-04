-- 046: form and comment quotas count over the billing window.
--
-- A subscribed workspace's AI, API and MCP quotas reset on its billing anniversary
-- (`usage-period.ts`), but forms and comments still counted the calendar month: the
-- screen and the payment provider's invoice (which closes on the anniversary) then
-- disagreed about how much a customer had used. The two atomic submit functions take
-- the window as `[p_window_start, p_window_end)`; both NULL keeps the calendar month,
-- which is what a workspace with no billing period (free, self-hosted) still gets.
--
-- Adding parameters creates an overload rather than replacing the function, and a call
-- by name would then be ambiguous, so the old signatures are dropped first. The new
-- parameters are defaulted: a caller that does not pass them behaves exactly as before.

DROP FUNCTION public.create_form_submission_if_allowed(uuid, integer, uuid, text, jsonb, text, inet, text, text, text);

CREATE FUNCTION public.create_form_submission_if_allowed(p_workspace_id uuid, p_monthly_limit integer, p_project_id uuid, p_model_id text, p_data jsonb, p_status text DEFAULT 'pending'::text, p_source_ip inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text, p_referrer text DEFAULT NULL::text, p_locale text DEFAULT 'en'::text, p_window_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_window_end timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_count INTEGER;
  v_submission public.form_submissions;
  v_start TIMESTAMPTZ := COALESCE(p_window_start, date_trunc('month', now()));
  v_end TIMESTAMPTZ := COALESCE(p_window_end, date_trunc('month', now()) + interval '1 month');
BEGIN
  -- Serialize concurrent submissions for same workspace
  PERFORM pg_advisory_xact_lock(
    hashtext('fs:' || p_workspace_id::text)
  );

  -- Count the window's submissions: the billing slice when the caller passes one,
  -- else the calendar month.
  SELECT COUNT(*) INTO v_count
  FROM public.form_submissions
  WHERE workspace_id = p_workspace_id
    AND created_at >= v_start
    AND created_at < v_end;

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

DROP FUNCTION public.create_comment_if_allowed(uuid, integer, uuid, text, text, text, uuid, integer, text, text, text, text, text, inet, text, text);

CREATE FUNCTION public.create_comment_if_allowed(
  p_workspace_id uuid,
  p_monthly_limit integer,
  p_project_id uuid,
  p_model_id text,
  p_entry_id text,
  p_locale text,
  p_parent_id uuid,
  p_max_depth integer,
  p_author_name text,
  p_author_email text,
  p_author_url text,
  p_body text,
  p_status text DEFAULT 'pending'::text,
  p_source_ip inet DEFAULT NULL::inet,
  p_user_agent text DEFAULT NULL::text,
  p_referrer text DEFAULT NULL::text,
  p_window_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_window_end timestamp with time zone DEFAULT NULL::timestamp with time zone
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_count INTEGER;
  v_parent public.comments;
  v_comment public.comments;
  v_start TIMESTAMPTZ := COALESCE(p_window_start, date_trunc('month', now()));
  v_end TIMESTAMPTZ := COALESCE(p_window_end, date_trunc('month', now()) + interval '1 month');
BEGIN
  -- Serialize concurrent submissions for the same workspace.
  PERFORM pg_advisory_xact_lock(
    hashtext('cm:' || p_workspace_id::text)
  );

  IF EXISTS (
    SELECT 1 FROM public.comment_threads t
     WHERE t.project_id = p_project_id
       AND t.model_id = p_model_id
       AND t.entry_id = p_entry_id
       AND t.locale = p_locale
       AND t.closed_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'thread_closed');
  END IF;

  IF p_parent_id IS NOT NULL THEN
    SELECT * INTO v_parent
      FROM public.comments
     WHERE id = p_parent_id
       AND project_id = p_project_id
       AND model_id = p_model_id
       AND entry_id = p_entry_id
       AND locale = p_locale;
    IF NOT FOUND OR v_parent.status <> 'approved' THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'parent_not_found');
    END IF;
    IF v_parent.depth + 1 > p_max_depth THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'depth_exceeded');
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM public.comments
   WHERE workspace_id = p_workspace_id
     AND source = 'web'
     AND created_at >= v_start
     AND created_at < v_end;

  IF v_count >= p_monthly_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'monthly_limit', 'current_count', v_count);
  END IF;

  INSERT INTO public.comments (
    project_id, workspace_id, model_id, entry_id, locale, parent_id,
    author_name, author_email, author_url, body, status, source,
    source_ip, user_agent, referrer
  )
  VALUES (
    p_project_id, p_workspace_id, p_model_id, p_entry_id, p_locale, p_parent_id,
    p_author_name, p_author_email, p_author_url, p_body, p_status, 'web',
    p_source_ip, p_user_agent, p_referrer
  )
  RETURNING * INTO v_comment;

  RETURN jsonb_build_object(
    'allowed', true,
    'current_count', v_count + 1,
    'comment', to_jsonb(v_comment)
  );
END;
$$;
