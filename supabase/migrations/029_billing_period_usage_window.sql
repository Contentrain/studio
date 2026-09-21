-- Align the usage quota window with the billing period (SO-13 B-2).
--
-- Quota counters are keyed by `month`, which held a calendar month
-- (`YYYY-MM`). Subscriptions bill from their own anniversary, so a
-- workspace that subscribed on the 21st got a fresh quota on the 1st —
-- ten days into a period it had already paid for. One free quota per
-- customer, sized by how late in the month they signed up.
--
-- A subscribed workspace is now keyed by its billing-period start date
-- (`YYYY-MM-DD`). Both forms share the column and cannot collide: seven
-- characters versus ten. Historical rows keep their key untouched.
--
-- Two things this migration has to do:
--   1. Record `current_period_start`. Providers send it; we only ever
--      stored the end, and deriving the start from the end is lossy at
--      month boundaries (31 March minus a month is 28 February, and the
--      arithmetic has to say so).
--   2. Seed the new key for workspaces that are mid-period right now.
--      Without this, the key changes under a live subscription and every
--      counter reads zero — handing out exactly the free quota this
--      migration exists to stop.

BEGIN;

ALTER TABLE public.payment_accounts
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz;

COMMENT ON COLUMN public.payment_accounts.current_period_start IS
  'Start of the provider billing period. Keys the usage quota window; see server/utils/usage-period.ts.';

-- Backfill from the end boundary. `interval '1 month'` clamps the day to
-- the target month (2026-03-31 - 1 month = 2026-02-28), which is the
-- same rule `addMonthsClamped` applies in application code.
UPDATE public.payment_accounts
SET current_period_start = current_period_end - interval '1 month'
WHERE current_period_start IS NULL
  AND current_period_end IS NOT NULL;

-- Seed the new window from what the calendar month has already counted,
-- for accounts whose period is open right now.
--
-- The seeded number is the calendar month's total, which for a period
-- that opened earlier in this same month also contains usage belonging
-- to the previous period. That over-counts the new window rather than
-- under-counting it: the alternative is starting from zero, which gives
-- away the quota this change is meant to protect. It self-corrects at
-- the next period roll, when the window and the counter start together.
WITH open_period AS (
  SELECT
    workspace_id,
    to_char(current_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period_key
  FROM public.payment_accounts
  WHERE is_active
    AND current_period_start IS NOT NULL
    AND current_period_start <= now()
    AND (current_period_end IS NULL OR current_period_end > now())
    AND subscription_status IN ('active', 'trialing', 'past_due', 'canceled')
)
INSERT INTO public.agent_usage (
  workspace_id, user_id, month, message_count, input_tokens, output_tokens,
  source, api_key_id, cache_creation_input_tokens, cache_read_input_tokens
)
SELECT
  au.workspace_id, au.user_id, op.period_key, au.message_count, au.input_tokens,
  au.output_tokens, au.source, au.api_key_id, au.cache_creation_input_tokens,
  au.cache_read_input_tokens
FROM public.agent_usage au
JOIN open_period op ON op.workspace_id = au.workspace_id
WHERE au.month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
ON CONFLICT (workspace_id, user_id, month, source) DO NOTHING;

WITH open_period AS (
  SELECT
    workspace_id,
    to_char(current_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period_key
  FROM public.payment_accounts
  WHERE is_active
    AND current_period_start IS NOT NULL
    AND current_period_start <= now()
    AND (current_period_end IS NULL OR current_period_end > now())
    AND subscription_status IN ('active', 'trialing', 'past_due', 'canceled')
)
INSERT INTO public.api_message_usage (
  workspace_id, api_key_id, month, message_count, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens
)
SELECT
  amu.workspace_id, amu.api_key_id, op.period_key, amu.message_count, amu.input_tokens,
  amu.output_tokens, amu.cache_creation_input_tokens, amu.cache_read_input_tokens
FROM public.api_message_usage amu
JOIN open_period op ON op.workspace_id = amu.workspace_id
WHERE amu.month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
ON CONFLICT (workspace_id, api_key_id, month) DO NOTHING;

WITH open_period AS (
  SELECT
    workspace_id,
    to_char(current_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period_key
  FROM public.payment_accounts
  WHERE is_active
    AND current_period_start IS NOT NULL
    AND current_period_start <= now()
    AND (current_period_end IS NULL OR current_period_end > now())
    AND subscription_status IN ('active', 'trialing', 'past_due', 'canceled')
)
INSERT INTO public.mcp_cloud_usage (workspace_id, month, mcp_key_id, call_count, last_call_at)
SELECT mcu.workspace_id, op.period_key, mcu.mcp_key_id, mcu.call_count, mcu.last_call_at
FROM public.mcp_cloud_usage mcu
JOIN open_period op ON op.workspace_id = mcu.workspace_id
WHERE mcu.month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
ON CONFLICT (workspace_id, month, mcp_key_id) DO NOTHING;

WITH open_period AS (
  SELECT
    workspace_id,
    to_char(current_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period_key
  FROM public.payment_accounts
  WHERE is_active
    AND current_period_start IS NOT NULL
    AND current_period_start <= now()
    AND (current_period_end IS NULL OR current_period_end > now())
    AND subscription_status IN ('active', 'trialing', 'past_due', 'canceled')
)
INSERT INTO public.mcp_oauth_usage (workspace_id, month, grant_id, call_count, last_call_at)
SELECT mou.workspace_id, op.period_key, mou.grant_id, mou.call_count, mou.last_call_at
FROM public.mcp_oauth_usage mou
JOIN open_period op ON op.workspace_id = mou.workspace_id
WHERE mou.month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
ON CONFLICT (workspace_id, month, grant_id) DO NOTHING;

COMMIT;
