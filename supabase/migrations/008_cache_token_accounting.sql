-- Anthropic prompt cache token accounting.
--
-- Anthropic's prompt cache splits an input call into three token
-- buckets in `response.usage`:
--
--   - input_tokens                   non-cached input, 1.0x base price
--   - cache_creation_input_tokens    written to cache this turn, 1.25x
--   - cache_read_input_tokens        served from cache this turn, 0.1x
--
-- The Studio billing model stays message-based (`ai.messages_per_month`,
-- `api.messages_per_month`) — cache tokens are observability for
-- Contentrain's cost-of-goods analysis, never customer-facing quota.
-- A workspace that benefits from cache hits does NOT earn extra
-- messages; gross margin improves silently.
--
-- Schema choices:
--   1. Separate columns mirror the existing `input_tokens`/`output_tokens`
--      pattern. Trivial to query, no jsonb gymnastics.
--   2. `input_tokens` semantic is UNCHANGED — still "non-cached input
--      tokens." Anthropic returns the buckets disjoint, so existing
--      dashboards built on `input_tokens` keep their meaning.
--   3. RPCs ship as `_v2` rather than mutating signatures in place.
--      Mid-deploy, the old app version + new RPC schema (or vice
--      versa) is a real failure mode on Supabase / PostgREST. The v1
--      RPCs stay registered and unused for safety; a follow-up
--      cleanup migration can drop them once every deploy is on v2.

-- ─────────────────────────────────────────────────────────────────
-- 1. Columns
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.agent_usage
  ADD COLUMN cache_creation_input_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_input_tokens bigint NOT NULL DEFAULT 0;

ALTER TABLE public.api_message_usage
  ADD COLUMN cache_creation_input_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_input_tokens bigint NOT NULL DEFAULT 0;

ALTER TABLE public.messages
  ADD COLUMN cache_creation_input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_input_tokens integer NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────
-- 2. v2 token increment RPCs
-- ─────────────────────────────────────────────────────────────────

CREATE FUNCTION public.increment_agent_usage_tokens_v2(
  p_workspace_id uuid,
  p_user_id uuid,
  p_month text,
  p_source text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cache_creation_input_tokens bigint,
  p_cache_read_input_tokens bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.agent_usage
  SET
    input_tokens = input_tokens + p_input_tokens,
    output_tokens = output_tokens + p_output_tokens,
    cache_creation_input_tokens = cache_creation_input_tokens + p_cache_creation_input_tokens,
    cache_read_input_tokens = cache_read_input_tokens + p_cache_read_input_tokens,
    updated_at = now()
  WHERE workspace_id = p_workspace_id
    AND user_id = p_user_id
    AND month = p_month
    AND source = p_source;
END;
$$;

CREATE FUNCTION public.increment_api_usage_tokens_v2(
  p_workspace_id uuid,
  p_api_key_id uuid,
  p_month text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cache_creation_input_tokens bigint,
  p_cache_read_input_tokens bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.api_message_usage
  SET
    input_tokens = input_tokens + p_input_tokens,
    output_tokens = output_tokens + p_output_tokens,
    cache_creation_input_tokens = cache_creation_input_tokens + p_cache_creation_input_tokens,
    cache_read_input_tokens = cache_read_input_tokens + p_cache_read_input_tokens,
    updated_at = now()
  WHERE workspace_id = p_workspace_id
    AND api_key_id = p_api_key_id
    AND month = p_month;
END;
$$;
