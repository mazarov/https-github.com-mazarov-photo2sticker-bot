-- 095_pack_content_sets_test.sql
-- Отдельная таблица для тестирования паков: на test (APP_ENV=test) бот и воркер читают из pack_content_sets_test.

-- Та же структура, что и pack_content_sets (без FK на pack_templates).
CREATE TABLE IF NOT EXISTS pack_content_sets_test (
  id text PRIMARY KEY,
  pack_template_id text NOT NULL DEFAULT '',
  name_ru text NOT NULL,
  name_en text NOT NULL,
  carousel_description_ru text,
  carousel_description_en text,
  labels jsonb NOT NULL,
  labels_en jsonb,
  scene_descriptions jsonb NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  mood text,
  created_at timestamptz DEFAULT now(),
  sticker_count int NOT NULL DEFAULT 9,
  subject_mode text DEFAULT 'any',
  cluster boolean NOT NULL DEFAULT false,
  CONSTRAINT pack_content_sets_test_subject_mode_check
    CHECK (subject_mode IN ('single', 'multi', 'any'))
);

CREATE INDEX IF NOT EXISTS idx_pack_content_sets_test_active_sort
  ON pack_content_sets_test (is_active, sort_order)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_pack_content_sets_test_subject_mode
  ON pack_content_sets_test (subject_mode)
  WHERE is_active = true;

COMMENT ON TABLE pack_content_sets_test IS 'Test pack content sets: used when APP_ENV=test. Same structure as pack_content_sets.';

-- Чтобы на test можно было сохранять в сессию id из pack_content_sets_test, убираем FK.
-- session.pack_content_set_id хранит id; приложение читает из нужной таблицы по APP_ENV.
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_pack_content_set_id_fkey;

COMMENT ON COLUMN sessions.pack_content_set_id IS 'Selected content set id (from pack_content_sets or pack_content_sets_test depending on env).';
