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
