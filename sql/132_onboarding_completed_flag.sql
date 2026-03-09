-- Add explicit onboarding completion flag for new onboarding router/menu.
ALTER TABLE users
ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false;

-- Backfill: existing active users should stay on post-onboarding UX.
UPDATE users
SET onboarding_completed = true
WHERE onboarding_completed = false
  AND (
    COALESCE(onboarding_step, 0) >= 2
    OR COALESCE(total_generations, 0) > 0
    OR COALESCE(has_purchased, false) = true
  );
