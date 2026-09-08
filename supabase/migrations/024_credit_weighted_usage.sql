-- 024: credit-weighted usage settle.
--
-- AI/API message quotas now count credits: the chat routes still
-- reserve 1 unit atomically before the model call, then settle the
-- difference (`estimateMessageCredits(...) - 1`, see
-- `shared/utils/ai-credits.ts`) once the turn's token totals are
-- known. The settle rides on the same statement that books the token
-- counters, so a `_v3` generation adds `p_message_count_delta` to the
-- `_v2` signatures from 008. `_v2` stays registered for
-- rolling-deploy safety (same posture 008 took toward `_v1`).
--
-- OR REPLACE, deliberately: this file first shipped as 023_..., was
-- renamed to 024_... (#244) after a version collision with
-- 023_branch_reviews, and the plain-Postgres runner keys
-- schema_migrations by FILENAME - environments that already ran the
-- 023-named copy re-run this file under its new name. Plain CREATE
-- made that re-run fail with "function already exists" and blocked
-- the staging deploy.

CREATE OR REPLACE FUNCTION public.increment_agent_usage_tokens_v3(
  p_workspace_id uuid,
  p_user_id uuid,
  p_month text,
  p_source text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cache_creation_input_tokens bigint,
  p_cache_read_input_tokens bigint,
  p_message_count_delta integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.agent_usage
  SET
    message_count = message_count + p_message_count_delta,
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

CREATE OR REPLACE FUNCTION public.increment_api_usage_tokens_v3(
  p_workspace_id uuid,
  p_api_key_id uuid,
  p_month text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cache_creation_input_tokens bigint,
  p_cache_read_input_tokens bigint,
  p_message_count_delta integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.api_message_usage
  SET
    message_count = message_count + p_message_count_delta,
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
