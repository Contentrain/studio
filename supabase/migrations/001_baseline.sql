-- Baseline schema — consolidates migrations 001..022 into a single canonical snapshot.
-- Generated from local Supabase stack (pg_dump --schema=public --schema-only).
-- Apply to a fresh database. Works on managed Supabase, self-hosted Supabase,
-- and plain Postgres 13+ (the latter needs a minimal auth-shim — see note below).

-- NOTE on plain Postgres: references to auth.users and auth.uid() come from
-- Supabase's GoTrue. On vanilla Postgres, provide a shim before running:
--   create schema if not exists auth;
--   create table if not exists auth.users (id uuid primary key);
--   create or replace function auth.uid() returns uuid language sql stable as $$
--     select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
--   $$;

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE SCHEMA IF NOT EXISTS public;

-- Required for gen_random_uuid() on plain Postgres. Supabase provisions this by default.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;


--
-- Name: audit_form_submission_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_form_submission_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.audit_logs (
    workspace_id,
    actor_id,
    action,
    table_name,
    record_id,
    record_snapshot,
    origin
  ) VALUES (
    OLD.workspace_id,
    NULLIF(current_setting('app.audit_actor_id', true), '')::UUID,
    'delete_form_submission',
    'form_submissions',
    OLD.id,
    row_to_json(OLD)::JSONB,
    CASE
      WHEN current_setting('app.audit_actor_id', true) IS NOT NULL
        AND current_setting('app.audit_actor_id', true) != ''
      THEN 'app'
      ELSE 'cascade'
    END
  );
  RETURN OLD;
END;
$$;


--
-- Name: cleanup_audit_logs(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_audit_logs(retention_days integer DEFAULT 90) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.audit_logs
  WHERE created_at < now() - (retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;


--
-- Name: create_cdn_key_if_allowed(uuid, uuid, text, character varying, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_cdn_key_if_allowed(p_project_id uuid, p_workspace_id uuid, p_key_hash text, p_key_prefix character varying, p_name text, p_limit integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: create_form_submission_if_allowed(uuid, integer, uuid, text, jsonb, text, inet, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_form_submission_if_allowed(p_workspace_id uuid, p_monthly_limit integer, p_project_id uuid, p_model_id text, p_data jsonb, p_status text DEFAULT 'pending'::text, p_source_ip inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text, p_referrer text DEFAULT NULL::text, p_locale text DEFAULT 'en'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: create_workspace_member_if_allowed(uuid, uuid, text, text, timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_workspace_member_if_allowed(p_workspace_id uuid, p_member_user_id uuid, p_role text, p_invited_email text, p_accepted_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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
  INSERT INTO public.workspaces (id, name, slug, type, owner_id, plan)
  VALUES (
    ws_id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ) || '''s Workspace',
    ws_slug,
    'primary',
    new.id,
    'free'
  );

  RETURN new;
END;
$$;


--
-- Name: handle_new_workspace(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_workspace() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.workspace_members (workspace_id, user_id, role, accepted_at)
  VALUES (new.id, new.owner_id, 'owner', now());
  RETURN new;
END;
$$;


--
-- Name: increment_agent_usage_if_allowed(uuid, uuid, uuid, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_agent_usage_if_allowed(p_workspace_id uuid, p_user_id uuid, p_api_key_id uuid DEFAULT NULL::uuid, p_month text DEFAULT ''::text, p_source text DEFAULT 'studio'::text, p_limit integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: increment_agent_usage_tokens(uuid, uuid, text, text, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_agent_usage_tokens(p_workspace_id uuid, p_user_id uuid, p_month text, p_source text, p_input_tokens bigint, p_output_tokens bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: increment_cdn_usage(uuid, uuid, date, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_cdn_usage(p_project_id uuid, p_api_key_id uuid, p_period_start date, p_request_count bigint, p_bandwidth_bytes bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: increment_mcp_cloud_usage_if_allowed(uuid, text, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_mcp_cloud_usage_if_allowed(p_workspace_id uuid, p_month text, p_key_id uuid, p_limit integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_current INTEGER;
BEGIN
  SELECT COALESCE(SUM(call_count), 0)
    INTO v_current
    FROM public.mcp_cloud_usage
   WHERE workspace_id = p_workspace_id
     AND month = p_month;

  IF p_limit IS NOT NULL AND v_current >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'used', v_current);
  END IF;

  INSERT INTO public.mcp_cloud_usage (workspace_id, month, mcp_key_id, call_count, last_call_at)
  VALUES (p_workspace_id, p_month, p_key_id, 1, now())
  ON CONFLICT (workspace_id, month, mcp_key_id)
  DO UPDATE SET
    call_count = public.mcp_cloud_usage.call_count + 1,
    last_call_at = now();

  RETURN jsonb_build_object('allowed', true, 'used', v_current + 1);
END;
$$;


--
-- Name: increment_storage_bytes(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_storage_bytes(p_workspace_id uuid, p_delta bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.workspaces
  SET media_storage_bytes = GREATEST(0, media_storage_bytes + p_delta)
  WHERE id = p_workspace_id;
END;
$$;


--
-- Name: reserve_storage_if_allowed(uuid, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_storage_if_allowed(p_workspace_id uuid, p_reserve_bytes bigint, p_limit_bytes bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    month text NOT NULL,
    message_count integer DEFAULT 0,
    input_tokens bigint DEFAULT 0,
    output_tokens bigint DEFAULT 0,
    source text DEFAULT 'studio'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    api_key_id uuid,
    CONSTRAINT agent_usage_source_check CHECK ((source = ANY (ARRAY['studio'::text, 'byoa'::text])))
);


--
-- Name: ai_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    encrypted_key text NOT NULL,
    key_hint text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ai_keys_provider_check CHECK ((provider = ANY (ARRAY['anthropic'::text, 'openai'::text])))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    actor_id uuid,
    action text NOT NULL,
    table_name text NOT NULL,
    record_id uuid NOT NULL,
    record_snapshot jsonb,
    source_ip inet,
    user_agent text,
    origin text DEFAULT 'app'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cdn_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cdn_api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    key_hash text NOT NULL,
    key_prefix character varying(16) NOT NULL,
    name text NOT NULL,
    environment text DEFAULT 'production'::text NOT NULL,
    rate_limit_per_hour integer DEFAULT 1000 NOT NULL,
    allowed_origins text[],
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT cdn_api_keys_environment_check CHECK ((environment = ANY (ARRAY['production'::text, 'preview'::text])))
);


--
-- Name: cdn_builds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cdn_builds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    trigger_type text DEFAULT 'webhook'::text NOT NULL,
    commit_sha text NOT NULL,
    branch text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    content_hash text,
    file_count integer,
    total_size_bytes bigint,
    changed_models text[],
    build_duration_ms integer,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT cdn_builds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'building'::text, 'success'::text, 'failed'::text]))),
    CONSTRAINT cdn_builds_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['webhook'::text, 'manual'::text, 'api'::text])))
);


--
-- Name: cdn_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cdn_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    api_key_id uuid,
    period_start date NOT NULL,
    request_count bigint DEFAULT 0 NOT NULL,
    bandwidth_bytes bigint DEFAULT 0 NOT NULL
);


--
-- Name: conversation_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    name text NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    specific_models boolean DEFAULT false NOT NULL,
    allowed_models text[] DEFAULT ARRAY[]::text[],
    allowed_tools text[] DEFAULT ARRAY[]::text[],
    allowed_locales text[] DEFAULT ARRAY[]::text[],
    custom_instructions text,
    ai_model text DEFAULT 'claude-sonnet-4-5'::text NOT NULL,
    rate_limit_per_minute integer DEFAULT 10 NOT NULL,
    monthly_message_limit integer DEFAULT 1000 NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT conversation_api_keys_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'admin'::text])))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: form_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    model_id text NOT NULL,
    data jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    source_ip inet,
    user_agent text,
    referrer text,
    locale text DEFAULT 'en'::text,
    approved_at timestamp with time zone,
    approved_by uuid,
    entry_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT form_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'spam'::text])))
);


--
-- Name: mcp_cloud_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_cloud_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    name text NOT NULL,
    allowed_tools text[] DEFAULT ARRAY[]::text[] NOT NULL,
    rate_limit_per_minute integer DEFAULT 60 NOT NULL,
    monthly_call_limit integer,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    revoked_at timestamp with time zone
);


--
-- Name: mcp_cloud_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_cloud_usage (
    workspace_id uuid NOT NULL,
    month text NOT NULL,
    mcp_key_id uuid NOT NULL,
    call_count integer DEFAULT 0 NOT NULL,
    last_call_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    filename text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    content_hash text NOT NULL,
    width integer,
    height integer,
    format text NOT NULL,
    blurhash text,
    focal_point jsonb,
    duration_seconds numeric,
    alt text,
    tags text[] DEFAULT ARRAY[]::text[],
    original_path text NOT NULL,
    variants jsonb DEFAULT '{}'::jsonb NOT NULL,
    uploaded_by uuid NOT NULL,
    source text DEFAULT 'upload'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_assets_source_check CHECK ((source = ANY (ARRAY['upload'::text, 'url'::text, 'connector'::text, 'agent'::text])))
);


--
-- Name: media_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    project_id uuid NOT NULL,
    model_id text NOT NULL,
    entry_id text NOT NULL,
    field_id text NOT NULL,
    locale text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    tool_calls jsonb,
    token_count_input integer DEFAULT 0,
    token_count_output integer DEFAULT 0,
    model text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);


--
-- Name: overage_billing_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.overage_billing_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    billing_period text NOT NULL,
    category text NOT NULL,
    units_billed numeric NOT NULL,
    unit_price numeric NOT NULL,
    total_amount numeric NOT NULL,
    stripe_invoice_item_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    display_name text,
    email text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now(),
    theme text DEFAULT 'system'::text NOT NULL,
    CONSTRAINT profiles_theme_check CHECK ((theme = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text])))
);


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid,
    role text NOT NULL,
    specific_models boolean DEFAULT false NOT NULL,
    allowed_models text[] DEFAULT '{}'::text[] NOT NULL,
    invited_email text,
    invited_at timestamp with time zone DEFAULT now(),
    accepted_at timestamp with time zone,
    CONSTRAINT project_members_role_check CHECK ((role = ANY (ARRAY['editor'::text, 'reviewer'::text, 'viewer'::text])))
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    repo_full_name text NOT NULL,
    default_branch text DEFAULT 'main'::text NOT NULL,
    content_root text DEFAULT '/'::text NOT NULL,
    detected_stack text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    content_updated_at timestamp with time zone,
    cdn_enabled boolean DEFAULT false NOT NULL,
    cdn_branch text,
    CONSTRAINT projects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'setup'::text, 'error'::text])))
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    webhook_id uuid NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    response_code integer,
    response_body text,
    retry_count integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text])))
);


--
-- Name: webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    url text NOT NULL,
    events text[] NOT NULL,
    secret text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    role text NOT NULL,
    invited_email text,
    invited_at timestamp with time zone DEFAULT now(),
    accepted_at timestamp with time zone,
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    type text DEFAULT 'primary'::text NOT NULL,
    owner_id uuid NOT NULL,
    logo_url text,
    github_installation_id bigint,
    plan text DEFAULT 'free'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    media_storage_bytes bigint DEFAULT 0 NOT NULL,
    trial_ends_at timestamp with time zone,
    stripe_customer_id text,
    stripe_subscription_id text,
    subscription_status text,
    subscription_current_period_end timestamp with time zone,
    subscription_cancel_at_period_end boolean DEFAULT false,
    grace_period_ends_at timestamp with time zone,
    overage_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    trial_reminder_stage integer DEFAULT 0 NOT NULL,
    CONSTRAINT workspaces_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'starter'::text, 'pro'::text, 'enterprise'::text]))),
    CONSTRAINT workspaces_subscription_status_check CHECK (((subscription_status IS NULL) OR (subscription_status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'incomplete'::text])))),
    CONSTRAINT workspaces_type_check CHECK ((type = ANY (ARRAY['primary'::text, 'secondary'::text])))
);


--
-- Name: agent_usage agent_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_pkey PRIMARY KEY (id);


--
-- Name: agent_usage agent_usage_workspace_id_user_id_month_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_workspace_id_user_id_month_source_key UNIQUE (workspace_id, user_id, month, source);


--
-- Name: ai_keys ai_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_keys
    ADD CONSTRAINT ai_keys_pkey PRIMARY KEY (id);


--
-- Name: ai_keys ai_keys_workspace_id_user_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_keys
    ADD CONSTRAINT ai_keys_workspace_id_user_id_provider_key UNIQUE (workspace_id, user_id, provider);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: cdn_api_keys cdn_api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_api_keys
    ADD CONSTRAINT cdn_api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: cdn_api_keys cdn_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_api_keys
    ADD CONSTRAINT cdn_api_keys_pkey PRIMARY KEY (id);


--
-- Name: cdn_builds cdn_builds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_builds
    ADD CONSTRAINT cdn_builds_pkey PRIMARY KEY (id);


--
-- Name: cdn_usage cdn_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_usage
    ADD CONSTRAINT cdn_usage_pkey PRIMARY KEY (id);


--
-- Name: cdn_usage cdn_usage_project_id_api_key_id_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_usage
    ADD CONSTRAINT cdn_usage_project_id_api_key_id_period_start_key UNIQUE (project_id, api_key_id, period_start);


--
-- Name: conversation_api_keys conversation_api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_api_keys
    ADD CONSTRAINT conversation_api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: conversation_api_keys conversation_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_api_keys
    ADD CONSTRAINT conversation_api_keys_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: form_submissions form_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_pkey PRIMARY KEY (id);


--
-- Name: mcp_cloud_keys mcp_cloud_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_cloud_keys
    ADD CONSTRAINT mcp_cloud_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: mcp_cloud_keys mcp_cloud_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_cloud_keys
    ADD CONSTRAINT mcp_cloud_keys_pkey PRIMARY KEY (id);


--
-- Name: mcp_cloud_usage mcp_cloud_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_cloud_usage
    ADD CONSTRAINT mcp_cloud_usage_pkey PRIMARY KEY (workspace_id, month, mcp_key_id);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);


--
-- Name: media_usage media_usage_asset_id_model_id_entry_id_field_id_locale_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_usage
    ADD CONSTRAINT media_usage_asset_id_model_id_entry_id_field_id_locale_key UNIQUE (asset_id, model_id, entry_id, field_id, locale);


--
-- Name: media_usage media_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_usage
    ADD CONSTRAINT media_usage_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: overage_billing_log overage_billing_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overage_billing_log
    ADD CONSTRAINT overage_billing_log_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (id);


--
-- Name: project_members project_members_project_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_user_id_key UNIQUE (project_id, user_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhooks webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (id);


--
-- Name: workspace_members workspace_members_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_slug_key UNIQUE (slug);


--
-- Name: idx_agent_usage_workspace_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_usage_workspace_month ON public.agent_usage USING btree (workspace_id, month);


--
-- Name: idx_ai_keys_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_keys_workspace ON public.ai_keys USING btree (workspace_id);


--
-- Name: idx_audit_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_created ON public.audit_logs USING btree (created_at);


--
-- Name: idx_audit_logs_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_workspace ON public.audit_logs USING btree (workspace_id, created_at DESC);


--
-- Name: idx_cdn_api_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdn_api_keys_hash ON public.cdn_api_keys USING btree (key_hash) WHERE (revoked_at IS NULL);


--
-- Name: idx_cdn_api_keys_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdn_api_keys_project ON public.cdn_api_keys USING btree (project_id);


--
-- Name: idx_cdn_builds_project_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdn_builds_project_status ON public.cdn_builds USING btree (project_id, status, started_at DESC);


--
-- Name: idx_conv_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_keys_hash ON public.conversation_api_keys USING btree (key_hash);


--
-- Name: idx_conv_keys_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_keys_project ON public.conversation_api_keys USING btree (project_id);


--
-- Name: idx_conversations_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_project ON public.conversations USING btree (project_id);


--
-- Name: idx_conversations_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_user ON public.conversations USING btree (user_id);


--
-- Name: idx_form_subs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_subs_created ON public.form_submissions USING btree (project_id, created_at);


--
-- Name: idx_form_subs_project_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_subs_project_model ON public.form_submissions USING btree (project_id, model_id, created_at DESC);


--
-- Name: idx_form_subs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_subs_status ON public.form_submissions USING btree (project_id, model_id, status);


--
-- Name: idx_mcp_cloud_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_cloud_keys_hash ON public.mcp_cloud_keys USING btree (key_hash);


--
-- Name: idx_mcp_cloud_keys_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_cloud_keys_project ON public.mcp_cloud_keys USING btree (project_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_mcp_cloud_keys_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_cloud_keys_workspace ON public.mcp_cloud_keys USING btree (workspace_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_mcp_cloud_usage_ws_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_cloud_usage_ws_month ON public.mcp_cloud_usage USING btree (workspace_id, month);


--
-- Name: idx_media_assets_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_hash ON public.media_assets USING btree (project_id, content_hash);


--
-- Name: idx_media_assets_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_project ON public.media_assets USING btree (project_id, created_at DESC);


--
-- Name: idx_media_assets_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_tags ON public.media_assets USING gin (tags);


--
-- Name: idx_media_usage_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_usage_asset ON public.media_usage USING btree (asset_id);


--
-- Name: idx_media_usage_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_usage_entry ON public.media_usage USING btree (model_id, entry_id);


--
-- Name: idx_messages_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_conversation ON public.messages USING btree (conversation_id);


--
-- Name: idx_overage_billing_log_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_overage_billing_log_unique ON public.overage_billing_log USING btree (workspace_id, billing_period, category);


--
-- Name: idx_overage_billing_log_ws_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_overage_billing_log_ws_period ON public.overage_billing_log USING btree (workspace_id, billing_period);


--
-- Name: idx_project_members_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_members_pending ON public.project_members USING btree (user_id) WHERE (accepted_at IS NULL);


--
-- Name: idx_project_members_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_members_project ON public.project_members USING btree (project_id);


--
-- Name: idx_project_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_members_user ON public.project_members USING btree (user_id);


--
-- Name: idx_projects_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_workspace ON public.projects USING btree (workspace_id);


--
-- Name: idx_projects_workspace_repo; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_projects_workspace_repo ON public.projects USING btree (workspace_id, repo_full_name);


--
-- Name: idx_webhook_deliveries_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_pending ON public.webhook_deliveries USING btree (status, next_retry_at) WHERE (status = 'pending'::text);


--
-- Name: idx_webhook_deliveries_webhook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_webhook ON public.webhook_deliveries USING btree (webhook_id, created_at DESC);


--
-- Name: idx_webhooks_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhooks_project ON public.webhooks USING btree (project_id);


--
-- Name: idx_workspace_members_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_members_pending ON public.workspace_members USING btree (user_id, workspace_id) WHERE (accepted_at IS NULL);


--
-- Name: idx_workspace_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_members_user ON public.workspace_members USING btree (user_id);


--
-- Name: idx_workspace_members_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_members_workspace ON public.workspace_members USING btree (workspace_id);


--
-- Name: idx_workspaces_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_owner ON public.workspaces USING btree (owner_id);


--
-- Name: idx_workspaces_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_slug ON public.workspaces USING btree (slug);


--
-- Name: idx_workspaces_stripe_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_stripe_customer ON public.workspaces USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL);


--
-- Name: idx_workspaces_stripe_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_stripe_subscription ON public.workspaces USING btree (stripe_subscription_id) WHERE (stripe_subscription_id IS NOT NULL);


--
-- Name: idx_workspaces_subscription_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_subscription_status ON public.workspaces USING btree (subscription_status) WHERE (subscription_status IS NOT NULL);


--
-- Name: idx_workspaces_trial_reminder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_trial_reminder ON public.workspaces USING btree (trial_ends_at, trial_reminder_stage) WHERE ((trial_ends_at IS NOT NULL) AND (subscription_status = 'trialing'::text));


--
-- Name: workspaces on_workspace_created; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_workspace_created AFTER INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.handle_new_workspace();


--
-- Name: form_submissions trg_audit_form_submission_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_form_submission_delete BEFORE DELETE ON public.form_submissions FOR EACH ROW EXECUTE FUNCTION public.audit_form_submission_delete();


--
-- Name: agent_usage agent_usage_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.conversation_api_keys(id);


--
-- Name: agent_usage agent_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: agent_usage agent_usage_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: ai_keys ai_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_keys
    ADD CONSTRAINT ai_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: ai_keys ai_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_keys
    ADD CONSTRAINT ai_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: cdn_api_keys cdn_api_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_api_keys
    ADD CONSTRAINT cdn_api_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: cdn_api_keys cdn_api_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_api_keys
    ADD CONSTRAINT cdn_api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: cdn_builds cdn_builds_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_builds
    ADD CONSTRAINT cdn_builds_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: cdn_usage cdn_usage_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_usage
    ADD CONSTRAINT cdn_usage_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.cdn_api_keys(id) ON DELETE SET NULL;


--
-- Name: cdn_usage cdn_usage_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cdn_usage
    ADD CONSTRAINT cdn_usage_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: conversation_api_keys conversation_api_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_api_keys
    ADD CONSTRAINT conversation_api_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: conversation_api_keys conversation_api_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_api_keys
    ADD CONSTRAINT conversation_api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: form_submissions form_submissions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.profiles(id);


--
-- Name: form_submissions form_submissions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: form_submissions form_submissions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: mcp_cloud_keys mcp_cloud_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_cloud_keys
    ADD CONSTRAINT mcp_cloud_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: mcp_cloud_keys mcp_cloud_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_cloud_keys
    ADD CONSTRAINT mcp_cloud_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: mcp_cloud_keys mcp_cloud_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_cloud_keys
    ADD CONSTRAINT mcp_cloud_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: mcp_cloud_usage mcp_cloud_usage_mcp_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_cloud_usage
    ADD CONSTRAINT mcp_cloud_usage_mcp_key_id_fkey FOREIGN KEY (mcp_key_id) REFERENCES public.mcp_cloud_keys(id) ON DELETE SET NULL;


--
-- Name: mcp_cloud_usage mcp_cloud_usage_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_cloud_usage
    ADD CONSTRAINT mcp_cloud_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id);


--
-- Name: media_assets media_assets_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: media_usage media_usage_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_usage
    ADD CONSTRAINT media_usage_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id) ON DELETE CASCADE;


--
-- Name: media_usage media_usage_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_usage
    ADD CONSTRAINT media_usage_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: overage_billing_log overage_billing_log_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overage_billing_log
    ADD CONSTRAINT overage_billing_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: projects projects_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_webhook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES public.webhooks(id) ON DELETE CASCADE;


--
-- Name: webhooks webhooks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: webhooks webhooks_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: workspaces Authenticated users can create workspaces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can create workspaces" ON public.workspaces FOR INSERT WITH CHECK ((auth.uid() = owner_id));


--
-- Name: workspaces Members can view workspaces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can view workspaces" ON public.workspaces FOR SELECT USING ((owner_id = auth.uid()));


--
-- Name: workspace_members Owner can add workspace members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner can add workspace members" ON public.workspace_members FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspaces
  WHERE ((workspaces.id = workspace_members.workspace_id) AND (workspaces.owner_id = auth.uid())))));


--
-- Name: workspaces Owner can delete workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner can delete workspace" ON public.workspaces FOR DELETE USING ((owner_id = auth.uid()));


--
-- Name: workspace_members Owner can remove workspace members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner can remove workspace members" ON public.workspace_members FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.workspaces
  WHERE ((workspaces.id = workspace_members.workspace_id) AND (workspaces.owner_id = auth.uid())))));


--
-- Name: workspaces Owner can update workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner can update workspace" ON public.workspaces FOR UPDATE USING ((owner_id = auth.uid()));


--
-- Name: workspace_members Owner can update workspace members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner can update workspace members" ON public.workspace_members FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.workspaces
  WHERE ((workspaces.id = workspace_members.workspace_id) AND (workspaces.owner_id = auth.uid())))));


--
-- Name: project_members Owner/Admin can add project members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner/Admin can add project members" ON public.project_members FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.projects p
     JOIN public.workspace_members wm ON ((wm.workspace_id = p.workspace_id)))
  WHERE ((p.id = project_members.project_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: projects Owner/Admin can create projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner/Admin can create projects" ON public.projects FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members
  WHERE ((workspace_members.workspace_id = projects.workspace_id) AND (workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: media_assets Owner/Admin can delete media assets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner/Admin can delete media assets" ON public.media_assets FOR DELETE USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: projects Owner/Admin can delete projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner/Admin can delete projects" ON public.projects FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.workspace_members
  WHERE ((workspace_members.workspace_id = projects.workspace_id) AND (workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: project_members Owner/Admin can remove project members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner/Admin can remove project members" ON public.project_members FOR DELETE USING ((EXISTS ( SELECT 1
   FROM (public.projects p
     JOIN public.workspace_members wm ON ((wm.workspace_id = p.workspace_id)))
  WHERE ((p.id = project_members.project_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: media_assets Owner/Admin can update media assets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner/Admin can update media assets" ON public.media_assets FOR UPDATE USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: project_members Owner/Admin can update project members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner/Admin can update project members" ON public.project_members FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM (public.projects p
     JOIN public.workspace_members wm ON ((wm.workspace_id = p.workspace_id)))
  WHERE ((p.id = project_members.project_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: projects Owner/Admin can update projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owner/Admin can update projects" ON public.projects FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.workspace_members
  WHERE ((workspace_members.workspace_id = projects.workspace_id) AND (workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: conversation_api_keys Service role can manage conversation keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage conversation keys" ON public.conversation_api_keys USING (true);


--
-- Name: mcp_cloud_keys Service role can manage mcp cloud keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage mcp cloud keys" ON public.mcp_cloud_keys USING (true);


--
-- Name: mcp_cloud_usage Service role can manage mcp cloud usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage mcp cloud usage" ON public.mcp_cloud_usage USING (true);


--
-- Name: webhook_deliveries Service role can manage webhook deliveries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage webhook deliveries" ON public.webhook_deliveries USING (true);


--
-- Name: webhooks Service role can manage webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage webhooks" ON public.webhooks USING (true);


--
-- Name: ai_keys Users can create AI keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create AI keys" ON public.ai_keys FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: conversations Users can create conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create conversations" ON public.conversations FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: ai_keys Users can delete own AI keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own AI keys" ON public.ai_keys FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: messages Users can insert own messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own messages" ON public.messages FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.conversations
  WHERE ((conversations.id = messages.conversation_id) AND (conversations.user_id = auth.uid())))));


--
-- Name: ai_keys Users can update own AI keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own AI keys" ON public.ai_keys FOR UPDATE USING ((user_id = auth.uid()));


--
-- Name: conversations Users can update own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own conversations" ON public.conversations FOR UPDATE USING ((user_id = auth.uid()));


--
-- Name: profiles Users can update own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING ((auth.uid() = id));


--
-- Name: ai_keys Users can view own AI keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own AI keys" ON public.ai_keys FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: conversations Users can view own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own conversations" ON public.conversations FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: workspace_members Users can view own memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own memberships" ON public.workspace_members FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: messages Users can view own messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own messages" ON public.messages FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.conversations
  WHERE ((conversations.id = messages.conversation_id) AND (conversations.user_id = auth.uid())))));


--
-- Name: profiles Users can view own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING ((auth.uid() = id));


--
-- Name: project_members Users can view own project memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own project memberships" ON public.project_members FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: agent_usage Users can view own usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own usage" ON public.agent_usage FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: form_submissions Workspace admin can delete form submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace admin can delete form submissions" ON public.form_submissions FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = form_submissions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: form_submissions Workspace admin can insert form submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace admin can insert form submissions" ON public.form_submissions FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = form_submissions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: form_submissions Workspace admin can update form submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace admin can update form submissions" ON public.form_submissions FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = form_submissions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: profiles Workspace co-members can view profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace co-members can view profiles" ON public.profiles FOR SELECT USING (((id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (public.workspaces w
     JOIN public.workspace_members wm ON ((wm.workspace_id = w.id)))
  WHERE ((w.owner_id = auth.uid()) AND (wm.user_id = profiles.id))))));


--
-- Name: cdn_builds Workspace members can insert CDN builds; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can insert CDN builds" ON public.cdn_builds FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.projects p
     JOIN public.workspace_members wm ON ((wm.workspace_id = p.workspace_id)))
  WHERE ((p.id = cdn_builds.project_id) AND (wm.user_id = auth.uid())))));


--
-- Name: media_assets Workspace members can insert media assets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can insert media assets" ON public.media_assets FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = media_assets.workspace_id) AND (wm.user_id = auth.uid())))));


--
-- Name: media_usage Workspace members can manage media usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can manage media usage" ON public.media_usage USING ((EXISTS ( SELECT 1
   FROM (public.media_assets ma
     JOIN public.workspace_members wm ON ((wm.workspace_id = ma.workspace_id)))
  WHERE ((ma.id = media_usage.asset_id) AND (wm.user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.media_assets ma
     JOIN public.workspace_members wm ON ((wm.workspace_id = ma.workspace_id)))
  WHERE ((ma.id = media_usage.asset_id) AND (wm.user_id = auth.uid())))));


--
-- Name: cdn_builds Workspace members can update CDN builds; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can update CDN builds" ON public.cdn_builds FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM (public.projects p
     JOIN public.workspace_members wm ON ((wm.workspace_id = p.workspace_id)))
  WHERE ((p.id = cdn_builds.project_id) AND (wm.user_id = auth.uid())))));


--
-- Name: cdn_builds Workspace members can view CDN builds; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view CDN builds" ON public.cdn_builds FOR SELECT USING ((project_id IN ( SELECT p.id
   FROM (public.projects p
     JOIN public.workspace_members wm ON ((wm.workspace_id = p.workspace_id)))
  WHERE (wm.user_id = auth.uid()))));


--
-- Name: audit_logs Workspace members can view audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view audit logs" ON public.audit_logs FOR SELECT USING (((workspace_id IS NULL) OR (workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid())))));


--
-- Name: conversation_api_keys Workspace members can view conversation keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view conversation keys" ON public.conversation_api_keys FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));


--
-- Name: form_submissions Workspace members can view form submissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view form submissions" ON public.form_submissions FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));


--
-- Name: mcp_cloud_keys Workspace members can view mcp cloud keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view mcp cloud keys" ON public.mcp_cloud_keys FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));


--
-- Name: mcp_cloud_usage Workspace members can view mcp cloud usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view mcp cloud usage" ON public.mcp_cloud_usage FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));


--
-- Name: media_assets Workspace members can view media assets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view media assets" ON public.media_assets FOR SELECT USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE (workspace_members.user_id = auth.uid()))));


--
-- Name: media_usage Workspace members can view media usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view media usage" ON public.media_usage FOR SELECT USING ((project_id IN ( SELECT p.id
   FROM (public.projects p
     JOIN public.workspace_members wm ON ((wm.workspace_id = p.workspace_id)))
  WHERE (wm.user_id = auth.uid()))));


--
-- Name: projects Workspace members can view projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view projects" ON public.projects FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.workspace_members
  WHERE ((workspace_members.workspace_id = projects.workspace_id) AND (workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (EXISTS ( SELECT 1
   FROM public.project_members
  WHERE ((project_members.project_id = projects.id) AND (project_members.user_id = auth.uid()))))));


--
-- Name: webhook_deliveries Workspace members can view webhook deliveries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view webhook deliveries" ON public.webhook_deliveries FOR SELECT USING ((webhook_id IN ( SELECT w.id
   FROM public.webhooks w
  WHERE (w.workspace_id IN ( SELECT wm.workspace_id
           FROM public.workspace_members wm
          WHERE (wm.user_id = auth.uid()))))));


--
-- Name: webhooks Workspace members can view webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can view webhooks" ON public.webhooks FOR SELECT USING ((workspace_id IN ( SELECT wm.workspace_id
   FROM public.workspace_members wm
  WHERE (wm.user_id = auth.uid()))));


--
-- Name: cdn_api_keys Workspace owner/admin can manage CDN keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owner/admin can manage CDN keys" ON public.cdn_api_keys USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: cdn_usage Workspace owner/admin can view CDN usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owner/admin can view CDN usage" ON public.cdn_usage FOR SELECT USING ((project_id IN ( SELECT p.id
   FROM (public.projects p
     JOIN public.workspace_members wm ON ((wm.workspace_id = p.workspace_id)))
  WHERE ((wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: agent_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: cdn_api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cdn_api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: cdn_builds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cdn_builds ENABLE ROW LEVEL SECURITY;

--
-- Name: cdn_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cdn_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: form_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_cloud_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mcp_cloud_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_cloud_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mcp_cloud_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: media_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: media_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: overage_billing_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.overage_billing_log ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: project_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: webhooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_members wm_owner_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wm_owner_manage ON public.workspace_members USING ((EXISTS ( SELECT 1
   FROM public.workspaces w
  WHERE ((w.id = workspace_members.workspace_id) AND (w.owner_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workspaces w
  WHERE ((w.id = workspace_members.workspace_id) AND (w.owner_id = auth.uid())))));


--
-- Name: workspace_members wm_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wm_select_own ON public.workspace_members FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: workspace_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

-- Trigger on auth.users (not captured by pg_dump --schema=public).
-- Forwards new user inserts to public.handle_new_user for profile + primary workspace creation.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
