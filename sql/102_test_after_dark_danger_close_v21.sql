-- 102_test_after_dark_danger_close_v21.sql (ТЕСТ)
-- Один пак: Опасно близко 2.1. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'after_dark_danger_close_v21',
  'couple_v1',
  'Опасно близко',
  'Dangerously close',
  'Ближе, смотри на меня, не отворачивайся, медленнее, останься, ночь только начинается.',
  'Come closer, look at me, don''t turn away, slower, stay, the night just started.',
  '["Подойди", "Ближе", "Смотри на меня", "Не отворачивайся", "Медленнее", "Ты чувствуешь?", "Не спеши", "Останься", "Ночь только начинается"]'::jsonb,
  '["Come closer", "Closer", "Look at me", "Don''t turn away", "Slower", "Feel it?", "No rush", "Stay", "The night just started"]'::jsonb,
  '[
    "{subject} wearing fitted jacket, framed mid-torso, shoulders squared, steady intense eye contact directly into camera",
    "{subject} mid-torso framing, slowly sliding jacket off one shoulder while keeping direct eye contact, subtle controlled expression",
    "{subject} in shirt with slightly unbuttoned collar, framed chest-up, slowly rolling up one sleeve with calm confident focus",
    "{subject} leaning one hand onto chair back within waist-up frame, body slightly angled, confident half-smile",
    "{subject} removing jacket fully within frame and letting it drop out of view, shoulders relaxing, gaze still locked",
    "{subject} in softer home shirt, framed closer, gently lowering chin while looking up through lashes",
    "{subject} waist-up framing, leaning slightly closer toward camera as if entering personal space, hands relaxed",
    "{subject} close-up framing, gently brushing fingers through hair, head slightly tilted, intimate steady eye contact",
    "{subject} close framing, loosely wrapped in light fabric or open shirt, stopping very close with calm slow intimate smile"
  ]'::jsonb,
  41, true, 'romantic', 9, 'single', false, 'after_dark'
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
