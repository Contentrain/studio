-- Migration: Billing system redesign
-- Adds free plan, subscription status tracking, grace period support.
-- Trial moves from internal timer to Stripe trial_period_days.

-- Step 1: Add subscription tracking columns
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_status text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end boolean DEFAULT false;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS grace_period_ends_at timestamptz;

-- Step 2: Add check constraint for subscription_status
ALTER TABLE workspaces ADD CONSTRAINT workspaces_subscription_status_check
  CHECK (subscription_status IS NULL OR subscription_status IN (
    'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete'
  ));

-- Step 3: Update plan check constraint to include 'free'
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_plan_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan_check
  CHECK (plan IN ('free', 'starter', 'pro', 'enterprise'));

-- Step 4: Change default plan to 'free'
ALTER TABLE workspaces ALTER COLUMN plan SET DEFAULT 'free';

-- Step 5: Indexes for webhook/billing lookups
CREATE INDEX IF NOT EXISTS idx_workspaces_stripe_subscription
  ON workspaces(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_subscription_status
  ON workspaces(subscription_status)
  WHERE subscription_status IS NOT NULL;

-- Step 6: Migrate existing data

-- Primary workspaces without Stripe subscription → free plan
UPDATE workspaces
SET plan = 'free', trial_ends_at = NULL
WHERE type = 'primary'
  AND stripe_subscription_id IS NULL
  AND (plan = 'starter' OR plan IS NULL);

-- Workspaces with active Stripe subscription → mark as active
UPDATE workspaces
SET subscription_status = 'active'
WHERE stripe_subscription_id IS NOT NULL
  AND plan IN ('starter', 'pro', 'enterprise');

-- Workspaces with running trial + Stripe subscription → mark as trialing
UPDATE workspaces
SET subscription_status = 'trialing'
WHERE trial_ends_at IS NOT NULL
  AND trial_ends_at > now()
  AND stripe_subscription_id IS NOT NULL;

-- Secondary workspaces with expired trial and no subscription → set grace period (7 days)
UPDATE workspaces
SET grace_period_ends_at = now() + interval '7 days'
WHERE type = 'secondary'
  AND trial_ends_at IS NOT NULL
  AND trial_ends_at < now()
  AND stripe_subscription_id IS NULL
  AND plan = 'starter';

-- Step 7: Update handle_new_user trigger — primary workspace gets plan='free'
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
