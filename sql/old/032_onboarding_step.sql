-- Add onboarding_step to track user onboarding progress
-- 0 = not started
-- 1 = first sticker created, waiting for emotion
-- 2 = emotion created, onboarding complete
-- 99 = onboarding skipped

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step int DEFAULT 0;

-- Set existing users to "skipped" (they already know the product)
UPDATE users SET onboarding_step = 99 WHERE onboarding_step IS NULL OR (onboarding_step = 0 AND total_generations > 0);

-- Atomic function to claim onboarding step 1 (first sticker)
-- Returns true if claimed, false if already past this step
CREATE OR REPLACE FUNCTION claim_onboarding_step_1(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  rows_affected int;
BEGIN
  UPDATE users 
  SET onboarding_step = 1, total_generations = COALESCE(total_generations, 0) + 1
  WHERE id = p_user_id AND (onboarding_step IS NULL OR onboarding_step = 0);
  
  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  RETURN rows_affected > 0;
END;
$$;

-- Atomic function to claim onboarding step 2 (emotion)
-- Returns true if claimed, false if already past this step
CREATE OR REPLACE FUNCTION claim_onboarding_step_2(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  rows_affected int;
BEGIN
  UPDATE users 
  SET onboarding_step = 2, total_generations = COALESCE(total_generations, 0) + 1
  WHERE id = p_user_id AND onboarding_step = 1;
  
  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  RETURN rows_affected > 0;
END;
$$;

-- Function to skip onboarding
CREATE OR REPLACE FUNCTION skip_onboarding(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users 
  SET onboarding_step = 99
  WHERE id = p_user_id AND onboarding_step < 2;
END;
$$;
