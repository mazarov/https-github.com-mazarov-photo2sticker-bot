-- 110_sync_pack_content_sets_from_test.sql
-- Перенос данных из pack_content_sets_test в pack_content_sets.
-- Запускать на БД, где есть обе таблицы (например после проверки на тесте — выгрузка и применение на проде,
-- либо на тестовой БД для синхронизации). На проде таблицы pack_content_sets_test нет — этот скрипт не для прямого запуска на проде.
-- Вариант использования: на тесте выполнить SELECT и вставить результат в pack_content_sets на проде через отдельную миграцию/скрипт,
-- либо запускать на копии прод-БД, куда предварительно скопирована структура _test и данные.

INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
)
SELECT
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
FROM pack_content_sets_test
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
  cluster = EXCLUDED.cluster,
  segment_id = EXCLUDED.segment_id;
