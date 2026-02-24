-- 101_test_after_dark_danger_close_v2.sql (ТЕСТ)
-- Один пак: Опасно близко 2.0. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'after_dark_danger_close_v2',
  'couple_v1',
  'Опасно близко',
  'Dangerously close',
  'Ближе, смотри, не отворачивайся, медленнее, останься, ночь длинная.',
  'Closer, look at me, don''t turn away, slower, stay, long night.',
  '["Подойди", "Ближе", "Смотри", "Не отворачивайся", "Медленнее", "Ты чувствуешь?", "Не спеши", "Останься", "Ночь длинная"]'::jsonb,
  '["Come closer", "Closer", "Look at me", "Don''t turn away", "Slower", "Feel it?", "No rush", "Stay", "Long night"]'::jsonb,
  '["{subject} wearing fitted jacket, standing upright and still with steady intense eye contact", "{subject} slowly taking off jacket from shoulders without breaking eye contact", "{subject} in shirt with slightly unbuttoned collar, slowly rolling up one sleeve", "{subject} leaning one hand on chair back, body slightly angled, confident half-smile", "{subject} removes jacket fully and lets it fall out of frame, shoulders relaxing", "{subject} in soft home shirt, gently lowering head while looking up through lashes", "{subject} taking one slow step forward, hands relaxed at sides, gaze locked", "{subject} barefoot, lightly brushing fingers through hair without breaking eye contact", "{subject} loosely wrapped in light fabric or open shirt, stopping very close with calm intimate smile"]'::jsonb,
  40, true, 'romantic', 9, 'single', false, 'after_dark'
)
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
