-- 133_pack_content_sets_onboarding_flag.sql
-- Add onboarding visibility flag for ready-made onboarding pack selection.

ALTER TABLE IF EXISTS pack_content_sets
  ADD COLUMN IF NOT EXISTS onboarding boolean NOT NULL DEFAULT true;

ALTER TABLE IF EXISTS pack_content_sets_test
  ADD COLUMN IF NOT EXISTS onboarding boolean NOT NULL DEFAULT true;

UPDATE pack_content_sets
SET onboarding = true
WHERE onboarding IS DISTINCT FROM true;

UPDATE pack_content_sets_test
SET onboarding = true
WHERE onboarding IS DISTINCT FROM true;
