-- Migration: Stripe billing integration
-- Adds Stripe customer and subscription tracking to workspaces

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

-- Index for webhook lookups by Stripe customer ID
CREATE INDEX IF NOT EXISTS idx_workspaces_stripe_customer
  ON workspaces(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
