-- 134_set_onboarding_pack_by_id.sql
-- Set exactly one onboarding pack by id (prod + test tables).
-- 1) Replace REPLACE_WITH_PACK_ID with real pack_content_sets.id
-- 2) Run migration.

DO $$
DECLARE
  v_pack_id text := 'REPLACE_WITH_PACK_ID';
  v_exists_prod boolean;
  v_exists_test boolean;
BEGIN
  -- Self-heal schema drift: ensure onboarding column exists in both tables.
  ALTER TABLE IF EXISTS pack_content_sets
    ADD COLUMN IF NOT EXISTS onboarding boolean NOT NULL DEFAULT false;
  ALTER TABLE IF EXISTS pack_content_sets_test
    ADD COLUMN IF NOT EXISTS onboarding boolean NOT NULL DEFAULT false;

  IF v_pack_id = 'REPLACE_WITH_PACK_ID' THEN
    RAISE EXCEPTION 'Set v_pack_id in migration before running';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pack_content_sets WHERE id = v_pack_id
  ) INTO v_exists_prod;

  SELECT EXISTS (
    SELECT 1 FROM pack_content_sets_test WHERE id = v_pack_id
  ) INTO v_exists_test;

  IF NOT v_exists_prod AND NOT v_exists_test THEN
    RAISE EXCEPTION 'Pack id % not found in pack_content_sets / pack_content_sets_test', v_pack_id;
  END IF;

  -- Keep one source of truth: only one onboarding pack.
  UPDATE pack_content_sets
  SET onboarding = (id = v_pack_id);

  UPDATE pack_content_sets_test
  SET onboarding = (id = v_pack_id);
END $$;
