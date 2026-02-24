-- 103_test_after_dark_danger_close_v23.sql (ТЕСТ)
-- Один пак: Опасно близко 2.3. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'after_dark_danger_close_v23',
  'couple_v1',
  'Опасно близко',
  'Dangerously close',
  'Подойди, ближе, смотри на меня, не отворачивайся, медленнее, останься — ночь только начинается.',
  'Come closer, closer, look at me, don''t turn away, slower, stay — the night just started.',
  '["Подойди", "Ближе", "Смотри на меня", "Не отворачивайся", "Медленнее", "Ты чувствуешь?", "Не спеши", "Останься", "Ночь только начинается"]'::jsonb,
  '["Come closer", "Closer", "Look at me", "Don''t turn away", "Slower", "Feel it?", "No rush", "Stay", "The night just started"]'::jsonb,
  '[
    "{subject} wearing fitted jacket, framed mid-torso, shoulders relaxed, calm steady eye contact with a restrained almost-curious smile",
    "{subject} mid-torso framing, slowly sliding jacket off one shoulder while keeping soft direct eye contact",
    "{subject} in shirt with slightly unbuttoned collar, framed chest-up, slowly rolling up one sleeve with composed focus",
    "{subject} waist-up framing, leaning one hand on chair back, body slightly angled, subtle half-smile forming",
    "{subject} removing jacket fully within frame and letting it fall out of view, shoulders easing as breath subtly lifts the chest",
    "{subject} in softer home shirt, framed closer, lowering chin slightly and looking up through lashes",
    "{subject} waist-up framing, leaning subtly closer into personal space, one hand resting lightly near collarbone",
    "{subject} framed chest-up, slowly slipping one side of an open shirt or light fabric off the shoulder, revealing collarbone, eyes briefly lowering then returning to camera",
    "{subject} framed chest-up, now wrapped loosely in softer fabric or nightwear, shoulders relaxed, head slightly turned away, slow knowing smile without direct eye contact"
  ]'::jsonb,
  43, true, 'romantic', 9, 'single', false, 'after_dark'
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
