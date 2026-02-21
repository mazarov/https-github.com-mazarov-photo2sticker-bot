-- fill_pack_content_sets_test.sql
-- Заполнение pack_content_sets_test из pack_content_sets (копия продовых наборов для теста).
-- Запускать на тестовой БД после применения миграции 095.
-- Можно вызывать повторно: существующие строки обновляются.

INSERT INTO pack_content_sets_test (
  id,
  pack_template_id,
  name_ru,
  name_en,
  carousel_description_ru,
  carousel_description_en,
  labels,
  labels_en,
  scene_descriptions,
  sort_order,
  is_active,
  mood,
  created_at,
  sticker_count,
  subject_mode,
  cluster
)
SELECT
  id,
  pack_template_id,
  name_ru,
  name_en,
  carousel_description_ru,
  carousel_description_en,
  labels,
  labels_en,
  scene_descriptions,
  sort_order,
  is_active,
  mood,
  created_at,
  sticker_count,
  subject_mode,
  cluster
FROM pack_content_sets
ON CONFLICT (id) DO UPDATE SET
  pack_template_id = EXCLUDED.pack_template_id,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood,
  sticker_count = EXCLUDED.sticker_count,
  subject_mode = EXCLUDED.subject_mode,
  cluster = EXCLUDED.cluster;
