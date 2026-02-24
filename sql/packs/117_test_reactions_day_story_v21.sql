-- 117_test_reactions_day_story_v21.sql (ТЕСТ)
-- Один пак: Реакции — Один день 2.1. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_day_story_v21',
  'couple_v1',
  'Реакции — Один день 2.1',
  'Reactions — One day 2.1',
  'Утро, работа, паузы, маленькие реакции и вечер. Один живой день.',
  'Morning, work, pauses, small reactions and evening. One real day.',
  '["Проснулась", "Ну началось", "Интересно", "Работаю", "Ну да", "Есть!", "Перерыв", "Хм", "Домой"]'::jsonb,
  '["Morning", "Here we go", "Interesting", "Working", "Well yeah", "Yes!", "Break", "Hmm", "Heading home"]'::jsonb,
  '[
    "{subject} in soft morning clothes stretching upward while taking a small step forward, arms beginning to lower, body in gentle diagonal motion",
    "{subject} holding a coffee cup mid-sip while phone in other hand vibrates, natural in-the-moment reaction without exaggeration",
    "{subject} placing the cup down outside the frame and pausing briefly with a slight squint, processing what was just heard",
    "{subject} leaning forward over a laptop actively typing, shoulders engaged, focused body posture",
    "{subject} slightly tilting head and running a hand through hair with a soft exhale — restrained internal reaction",
    "{subject} making a small contained fist pump near chest while shifting weight onto one leg, subtle satisfaction",
    "{subject} placing both hands on the edge of a desk and slowly pushing back to straighten up, visible change of rhythm",
    "{subject} taking a step forward then briefly turning torso back as if reconsidering something",
    "{subject} pulling hoodie over head or adjusting jacket while beginning to turn away, body already in motion as if heading home"
  ]'::jsonb,
  120, true, 'reactions', 9, 'single', false, 'reactions'
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
