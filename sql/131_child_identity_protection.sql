-- Child identity protection for style generation:
-- 1) Store source-bound age profile in sessions
-- 2) Add app_config flags for safe rollout

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_age_group text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_age_confidence numeric;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_age_source_file_id text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_age_source_kind text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_age_detected_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_subject_age_group_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_subject_age_group_check
      CHECK (subject_age_group IS NULL OR subject_age_group IN ('child', 'adult', 'unknown'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_subject_age_source_kind_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_subject_age_source_kind_check
      CHECK (subject_age_source_kind IS NULL OR subject_age_source_kind IN ('photo', 'sticker'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_sessions_subject_age_source
  ON sessions (subject_age_source_file_id, subject_age_source_kind);

INSERT INTO app_config (key, value, description)
VALUES
  ('child_identity_protection_enabled', 'false', 'Enable child-safe identity policy for style generation'),
  ('child_identity_confidence_min', '0.75', 'Minimum confidence for subject_age_group != unknown')
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    updated_at = now();
