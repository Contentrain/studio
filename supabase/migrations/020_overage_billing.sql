-- Overage billing: workspace preferences + audit log.
--
-- overage_settings JSONB stores per-category toggle:
-- { "ai_messages": true, "cdn_bandwidth": false, ... }
-- When a key is true, usage past the plan limit is allowed and charged as overage.
-- When absent or false, hard cap (current behavior) applies.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS overage_settings JSONB NOT NULL DEFAULT '{}';

-- ============================================================
-- Overage billing audit log — prevents double-billing.
-- Each row = one overage line item submitted to Stripe.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.overage_billing_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  billing_period TEXT NOT NULL,            -- YYYY-MM
  category TEXT NOT NULL,                  -- ai_messages, api_messages, cdn_bandwidth, form_submissions, media_storage
  units_billed NUMERIC NOT NULL,           -- number of overage units billed
  unit_price NUMERIC NOT NULL,             -- price per unit at billing time (USD)
  total_amount NUMERIC NOT NULL,           -- units_billed * unit_price
  stripe_invoice_item_id TEXT,             -- Stripe InvoiceItem ID for audit trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_overage_billing_log_ws_period
  ON public.overage_billing_log(workspace_id, billing_period);

-- Unique constraint prevents double-billing for same category in same period
CREATE UNIQUE INDEX IF NOT EXISTS idx_overage_billing_log_unique
  ON public.overage_billing_log(workspace_id, billing_period, category);

ALTER TABLE public.overage_billing_log ENABLE ROW LEVEL SECURITY;
