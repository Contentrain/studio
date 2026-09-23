-- 035: the credit unit a payment account is billed in (catalog v2, PRC-3).
--
-- Catalog v2 sells AI/API credits of $0.01 on new meters (`ai_credits_1c`,
-- `api_credits_1c`); subscriptions sold before it keep $0.03 credits on the
-- original meters, their quotas and their prices (founder decision: no
-- forced migration). Every credit figure the app computes — quota, turn
-- ceiling, settle, meter, overage price — is read through this column
-- (`shared/utils/credit-unit.ts`). The billing webhook writes it from the
-- meters the subscription is priced on.
--
-- Every row that exists now was sold before v2: '0.03'. New rows default to
-- the current unit.

ALTER TABLE public.payment_accounts
  ADD COLUMN IF NOT EXISTS credit_unit text NOT NULL DEFAULT '0.01'
  CHECK (credit_unit IN ('0.03', '0.01'));

UPDATE public.payment_accounts SET credit_unit = '0.03';

-- Changing an account's unit mid-period (a subscription moved from a pre-v2
-- product to a v2 one, or back) must not change what the period's usage is
-- worth: the counters of the period being consumed are converted in the
-- same transaction — ×3 into $0.01 credits, ÷3 (rounded up) back into $0.03
-- ones. Only credit counters: Studio-funded AI turns (BYOA rows count turns)
-- and Conversation API usage. Returns whether the unit changed.
CREATE OR REPLACE FUNCTION public.set_payment_account_credit_unit(
  p_workspace_id uuid,
  p_unit text,
  p_period_key text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_old text;
BEGIN
  IF p_unit NOT IN ('0.03', '0.01') THEN
    RAISE EXCEPTION 'invalid credit unit %', p_unit;
  END IF;

  SELECT credit_unit INTO v_old
  FROM public.payment_accounts
  WHERE workspace_id = p_workspace_id AND is_active
  FOR UPDATE;

  IF v_old IS NULL OR v_old = p_unit THEN
    RETURN false;
  END IF;

  UPDATE public.payment_accounts
  SET credit_unit = p_unit
  WHERE workspace_id = p_workspace_id AND is_active;

  IF v_old = '0.03' THEN
    UPDATE public.agent_usage SET message_count = message_count * 3
    WHERE workspace_id = p_workspace_id AND month = p_period_key AND source = 'studio';
    UPDATE public.api_message_usage SET message_count = message_count * 3
    WHERE workspace_id = p_workspace_id AND month = p_period_key;
  ELSE
    UPDATE public.agent_usage SET message_count = ceil(message_count / 3.0)::integer
    WHERE workspace_id = p_workspace_id AND month = p_period_key AND source = 'studio';
    UPDATE public.api_message_usage SET message_count = ceil(message_count / 3.0)::integer
    WHERE workspace_id = p_workspace_id AND month = p_period_key;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.set_payment_account_credit_unit(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_payment_account_credit_unit(uuid, text, text) TO service_role;
