-- CLOVENT Phase 5b — Add 'pro' plan to all plan CHECK constraints

-- Drop and recreate the constraint on organizations to include 'pro'
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_plan_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_plan_check
    CHECK (plan IN ('starter','growth','pro','enterprise'));

-- Same for subscriptions table
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('starter','growth','pro','enterprise'));

-- Update Growth plan price reference in any existing subscriptions
-- (in case anyone is on the old $149 growth — we honor their subscription,
--  Stripe handles the price, we just update the label)
-- This is a no-op if no rows exist yet.
