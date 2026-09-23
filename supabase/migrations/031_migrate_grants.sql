-- 031: Studio included with a paid Migrate order (XS-1).
--
-- A Migrate order carries "N days of Studio {plan}". Migrate hands it over
-- as a signed, single-use claim token; Studio records it here, one row per
-- order, and turns it into a provider trial of that length at checkout.
--
-- The row is the grant's whole lifecycle:
--   claimed  — `user_id` set: the Studio user who opened the link owns it.
--   bound    — `workspace_id` + `bound_at` set when its checkout is first
--              opened: the grant can only ever start a trial on this one
--              workspace, even if that checkout is abandoned.
--   redeemed — `redeemed_at` set by the billing webhook when the
--              subscription that checkout created arrives (its metadata
--              carries the grant id). A redeemed grant opens no further
--              checkout, so cancel-and-resubscribe does not repeat the
--              included days.
--
-- Service-role only: RLS on, no policies. Both DatabaseProviders read and
-- write it through their admin client.
--
-- Also: the trial reminder sequence gains a T-7 step (long included trials
-- need more than three days' notice). The stage cursor is monotonic, so the
-- existing steps move up by one and so do the cursors already in flight —
-- otherwise a workspace that got its T-3 mail would get it again.

CREATE TABLE public.migrate_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  claim_jti text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('starter', 'pro')),
  trial_days integer NOT NULL CHECK (trial_days BETWEEN 1 AND 90),
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  email text NOT NULL,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  bound_at timestamp with time zone,
  redeemed_at timestamp with time zone,
  redeemed_subscription_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT migrate_grants_order_unique UNIQUE (order_id),
  -- A bound grant always says when. `workspace_id` alone can go back to
  -- NULL (workspace deleted); `bound_at` stays, so the grant cannot move on.
  CONSTRAINT migrate_grants_bound_at CHECK (workspace_id IS NULL OR bound_at IS NOT NULL)
);

CREATE INDEX idx_migrate_grants_user ON public.migrate_grants (user_id);
CREATE INDEX idx_migrate_grants_workspace ON public.migrate_grants (workspace_id) WHERE workspace_id IS NOT NULL;

ALTER TABLE public.migrate_grants ENABLE ROW LEVEL SECURITY;

-- T-7 becomes stage 1; T-3, T-1, T-0 move to 2, 3, 4.
UPDATE public.workspaces
SET trial_reminder_stage = trial_reminder_stage + 1
WHERE trial_reminder_stage > 0;
