-- Migration: Plan restructure
-- Plans: starter ($9/mo), pro ($29/mo + seats), enterprise (custom)
-- Trial is a state (trial_ends_at), not a plan type
-- All features available on all plans — difference is usage limits

-- Step 1: Add trial_ends_at column
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

-- Step 2: Migrate existing plan values
UPDATE workspaces SET plan = 'starter' WHERE plan = 'free';
UPDATE workspaces SET plan = 'pro' WHERE plan IN ('business', 'team');

-- Step 3: Update check constraint
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_plan_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan_check
  CHECK (plan IN ('starter', 'pro', 'enterprise'));

-- Step 4: Set default to starter
ALTER TABLE workspaces ALTER COLUMN plan SET DEFAULT 'starter';

-- Step 5: Set trial for existing workspaces that were on free plan
-- (14 days from migration date — adjust as needed)
UPDATE workspaces
SET trial_ends_at = now() + interval '14 days'
WHERE trial_ends_at IS NULL AND plan = 'starter';
