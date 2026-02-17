-- Object Profile Contract (phase 2, additive)
-- Safe rollout: add object_* mirrors and object-first feature flags.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS object_mode text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS object_count integer;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS object_confidence numeric;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS object_source_file_id text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS object_source_kind text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS object_detected_at timestamptz;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS object_instances_json jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_object_mode_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_object_mode_check
      CHECK (object_mode IS NULL OR object_mode IN ('single', 'multi', 'unknown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_object_source_kind_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_object_source_kind_check
      CHECK (object_source_kind IS NULL OR object_source_kind IN ('photo', 'sticker'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_object_source
  ON sessions (object_source_file_id, object_source_kind);

CREATE INDEX IF NOT EXISTS idx_sessions_object_mode
  ON sessions (object_mode)
  WHERE object_mode IS NOT NULL;

INSERT INTO app_config (key, value, description)
VALUES
  ('object_profile_enabled', 'false', 'Enable object profile persistence in sessions'),
  ('object_lock_enabled', 'false', 'Inject object-based lock block into generation prompts'),
  ('object_mode_pack_filter_enabled', 'false', 'Enable pack content set compatibility using object_mode'),
  ('object_profile_shadow_enabled', 'false', 'Run object-profile detector in shadow mode (no hard switch)'),
  ('object_edge_filter_enabled', 'false', 'Ignore small edge-touching peripheral fragments when counting main objects'),
  ('object_multi_confidence_min', '0.85', 'Minimum confidence to keep object_mode=multi'),
  ('object_multi_low_confidence_fallback', 'unknown', 'Fallback mode when multi confidence is below threshold'),
  ('object_min_area_ratio', '0.06', 'Minimum area ratio to consider detected object as main'),
  ('object_edge_small_area_max', '0.12', 'Max area ratio for edge-touching objects to be considered peripheral')
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    updated_at = now();
