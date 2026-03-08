ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS style_source_kind text NOT NULL DEFAULT 'photo';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_style_source_kind_check'
  ) THEN
    ALTER TABLE sessions
    ADD CONSTRAINT sessions_style_source_kind_check
    CHECK (style_source_kind IN ('photo', 'sticker'));
  END IF;
END $$;
