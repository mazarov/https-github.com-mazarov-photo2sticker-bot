-- 094_subject_gender.sql
-- Пол субъекта на фото (для single): male | female | unknown. Детектор возвращает subject_gender; сохраняем в сессию для паков (подстановка man/woman в промпт).

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS subject_gender text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS object_gender text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_subject_gender_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_subject_gender_check
      CHECK (subject_gender IS NULL OR subject_gender IN ('male', 'female', 'unknown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_object_gender_check'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_object_gender_check
      CHECK (object_gender IS NULL OR object_gender IN ('male', 'female', 'unknown'));
  END IF;
END $$;

COMMENT ON COLUMN sessions.subject_gender IS 'Detected gender of the single main subject (person): male | female | unknown. Used for pack scene placeholder {subject} -> man/woman.';
COMMENT ON COLUMN sessions.object_gender IS 'Mirror of subject_gender for object-profile flow.';
