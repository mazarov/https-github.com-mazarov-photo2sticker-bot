-- 098_pack_segments.sql
-- Сегменты паков для UI (19-02-pack-2): группы для навигации в карусели.

-- Таблица сегментов (первый уровень выбора в UI)
CREATE TABLE IF NOT EXISTS pack_segments (
  id text PRIMARY KEY,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);

INSERT INTO pack_segments (id, name_ru, name_en, sort_order) VALUES
  ('reactions', 'Реакции', 'Reactions', 1),
  ('sarcasm', 'Сарказм', 'Sarcasm', 2),
  ('home', 'Дом', 'Home', 3),
  ('events', 'События', 'Events', 4),
  ('affection_support', 'Нежность / поддержка', 'Affection & support', 5),
  ('after_dark', 'After Dark', 'After Dark', 6),
  ('boundaries', 'Границы', 'Boundaries', 7)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  sort_order = EXCLUDED.sort_order;

-- Привязка набора к сегменту
ALTER TABLE pack_content_sets ADD COLUMN IF NOT EXISTS segment_id text REFERENCES pack_segments(id);
CREATE INDEX IF NOT EXISTS idx_pack_content_sets_segment ON pack_content_sets (segment_id) WHERE is_active = true;
COMMENT ON COLUMN pack_content_sets.segment_id IS 'Segment for UI grouping (19-02-pack-2).';

-- Та же колонка для тестовой таблицы (если есть)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pack_content_sets_test') THEN
    ALTER TABLE pack_content_sets_test ADD COLUMN IF NOT EXISTS segment_id text REFERENCES pack_segments(id);
    CREATE INDEX IF NOT EXISTS idx_pack_content_sets_test_segment ON pack_content_sets_test (segment_id) WHERE is_active = true;
  END IF;
END $$;

-- Backfill segment_id для текущих паков (097 / ранние наборы)
UPDATE pack_content_sets SET segment_id = 'sarcasm' WHERE id IN ('humor', 'sass');
UPDATE pack_content_sets SET segment_id = 'home' WHERE id = 'everyday_solo';
UPDATE pack_content_sets SET segment_id = 'affection_support' WHERE id IN ('thanks_solo', 'affection_solo');
UPDATE pack_content_sets SET segment_id = 'reactions' WHERE id IN ('reactions_emotions', 'reactions_solo');
UPDATE pack_content_sets SET segment_id = 'events' WHERE id = 'holiday_solo';

UPDATE pack_content_sets_test SET segment_id = 'sarcasm' WHERE id IN ('humor', 'sass');
UPDATE pack_content_sets_test SET segment_id = 'home' WHERE id = 'everyday_solo';
UPDATE pack_content_sets_test SET segment_id = 'affection_support' WHERE id IN ('thanks_solo', 'affection_solo');
UPDATE pack_content_sets_test SET segment_id = 'reactions' WHERE id IN ('reactions_emotions', 'reactions_solo');
UPDATE pack_content_sets_test SET segment_id = 'events' WHERE id = 'holiday_solo';
