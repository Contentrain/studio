-- Plugin-based payment provider storage.
--
-- Moves billing state from dedicated columns on `workspaces` into a
-- normalised `payment_accounts` table so multiple providers (Stripe,
-- Polar, Paddle, …) can coexist without schema growth. Introduces
-- `usage_events_outbox` as the provider-agnostic meter pipeline,
-- replacing the Stripe-specific `overage_billing_log` (invoice-item
-- model). The legacy billing columns on `workspaces` are dropped —
-- safe because Studio is pre-launch and no production subscription
-- rows exist.

-- =========================================================================
-- payment_accounts — per-provider subscription state, one active per workspace
-- =========================================================================

CREATE TABLE public.payment_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  customer_id text NOT NULL,
  subscription_id text,
  subscription_status text,
  current_period_end timestamp with time zone,
  trial_ends_at timestamp with time zone,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  grace_period_ends_at timestamp with time zone,
  plan text,
  plugin_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  archived_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT payment_accounts_provider_check
    CHECK (provider IN ('stripe', 'polar')),
  CONSTRAINT payment_accounts_status_check
    CHECK (subscription_status IS NULL OR subscription_status IN
      ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired')),
  CONSTRAINT payment_accounts_workspace_provider_customer_unique
    UNIQUE (workspace_id, provider, customer_id)
);

-- At most one active account per workspace. Archived accounts (is_active=false)
-- remain for history but never gate runtime behavior.
CREATE UNIQUE INDEX idx_payment_accounts_one_active
  ON public.payment_accounts (workspace_id)
  WHERE is_active;

CREATE INDEX idx_payment_accounts_workspace
  ON public.payment_accounts (workspace_id);

CREATE INDEX idx_payment_accounts_subscription
  ON public.payment_accounts (provider, subscription_id)
  WHERE subscription_id IS NOT NULL;

-- Trial reminder cron scans active trialing accounts; index tuned for that path.
CREATE INDEX idx_payment_accounts_trial_reminder
  ON public.payment_accounts (trial_ends_at)
  WHERE is_active AND subscription_status = 'trialing';

-- Auto-bump updated_at on any UPDATE
CREATE OR REPLACE FUNCTION public.payment_accounts_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_accounts_updated_at
  BEFORE UPDATE ON public.payment_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.payment_accounts_set_updated_at();

-- Server-only access (service role); no user-facing policies.
ALTER TABLE public.payment_accounts ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- usage_events_outbox — provider-agnostic meter event queue
-- =========================================================================
--
-- Every usage event (AI message, form submission, CDN byte, MCP call, …)
-- is written here first. A drain cron in the server reads pending events
-- and pushes them to the active PaymentProvider's meter API (Polar meter
-- ingestion, Paddle adjustments, etc.). Idempotency key prevents double-
-- ingestion across retries; the UNIQUE constraint enforces it.

CREATE TABLE public.usage_events_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meter_name text NOT NULL,
  value numeric NOT NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamp with time zone,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT usage_events_outbox_idempotency_unique
    UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX idx_usage_events_outbox_pending
  ON public.usage_events_outbox (occurred_at)
  WHERE ingested_at IS NULL;

CREATE INDEX idx_usage_events_outbox_workspace
  ON public.usage_events_outbox (workspace_id, meter_name, occurred_at);

ALTER TABLE public.usage_events_outbox ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- Drop legacy billing columns from workspaces
-- =========================================================================

DROP INDEX IF EXISTS public.idx_workspaces_stripe_customer;
DROP INDEX IF EXISTS public.idx_workspaces_stripe_subscription;
DROP INDEX IF EXISTS public.idx_workspaces_subscription_status;
DROP INDEX IF EXISTS public.idx_workspaces_trial_reminder;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_subscription_status_check;

ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id,
  DROP COLUMN IF EXISTS subscription_status,
  DROP COLUMN IF EXISTS subscription_current_period_end,
  DROP COLUMN IF EXISTS subscription_cancel_at_period_end,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS grace_period_ends_at;

-- trial_reminder_stage stays — it is a workspace-level monotonic counter
-- used by the reminder cron, not provider-specific billing state.

-- =========================================================================
-- Drop legacy overage_billing_log — replaced by usage_events_outbox
-- =========================================================================

DROP TABLE IF EXISTS public.overage_billing_log CASCADE;
