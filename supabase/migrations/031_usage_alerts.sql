-- 031: usage alert send log (80 % / 100 % emails).
--
-- The billing screen warned at 80 % and 100 %, but only to an owner who
-- opened Settings › Billing. Nobody was told when AI credits ran out, and a
-- public form or comment limit silently turned visitors away — the owner
-- found out from a lost lead. `server/plugins/usage-alerts.ts` now emails the
-- owner once per meter, period and threshold; this table is how it remembers
-- it already did.
--
-- One row per (workspace, meter, period, threshold). The primary key is the
-- claim: the job inserts first and sends only if the insert won, so two app
-- instances never send the same alert twice. A failed send deletes the row
-- so the next run retries.
--
-- Server-only: RLS on, no policies. Reverting is dropping the table; nothing
-- else reads it.

CREATE TABLE IF NOT EXISTS public.usage_alerts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meter text NOT NULL,
  period_key text NOT NULL,
  threshold smallint NOT NULL CHECK (threshold IN (80, 100)),
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, meter, period_key, threshold)
);

ALTER TABLE public.usage_alerts ENABLE ROW LEVEL SECURITY;
