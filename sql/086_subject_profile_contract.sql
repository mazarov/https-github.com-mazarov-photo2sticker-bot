-- Subject Profile Contract (phase 1)
-- Safe rollout: profile + lock infra + pack_content_sets compatibility field.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_mode text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_count integer;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_confidence numeric;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_source_file_id text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_source_kind text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_detected_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_subject_mode_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_subject_mode_check
      CHECK (subject_mode IS NULL OR subject_mode IN ('single', 'multi', 'unknown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_subject_source_kind_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_subject_source_kind_check
      CHECK (subject_source_kind IS NULL OR subject_source_kind IN ('photo', 'sticker'));
  END IF;
END $$;

ALTER TABLE pack_content_sets
  ADD COLUMN IF NOT EXISTS subject_mode text DEFAULT 'any';

UPDATE pack_content_sets
SET subject_mode = 'any'
WHERE subject_mode IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pack_content_sets_subject_mode_check'
  ) THEN
    ALTER TABLE pack_content_sets
      ADD CONSTRAINT pack_content_sets_subject_mode_check
      CHECK (subject_mode IN ('single', 'multi', 'any'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_subject_source
  ON sessions (subject_source_file_id, subject_source_kind);

CREATE INDEX IF NOT EXISTS idx_pack_content_sets_subject_mode
  ON pack_content_sets (subject_mode)
  WHERE is_active = true;

INSERT INTO app_config (key, value, description)
VALUES
  ('gemini_model_subject_detector', 'gemini-2.0-flash', 'Model used to detect subject count/profile from source image'),
  ('subject_profile_enabled', 'false', 'Enable subject profile detection and session persistence'),
  ('subject_lock_enabled', 'false', 'Inject subject lock block into generation prompts'),
  ('subject_mode_pack_filter_enabled', 'false', 'Filter pack content sets by subject_mode compatibility'),
  ('subject_postcheck_enabled', 'false', 'Enable post-generation subject-count validation')
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    updated_at = now();
