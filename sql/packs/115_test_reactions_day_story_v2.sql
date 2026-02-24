-- 115_test_reactions_day_story_v2.sql (ТЕСТ)
-- Один пак: Реакции — Один день 2.0. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_day_story_v2',
  'couple_v1',
  'Реакции — Один день 2.0',
  'Reactions — One day 2.0',
  'Утро, работа, неловкость, маленькие победы и вечер. День в движении.',
  'Morning, work, awkward moments, small wins and evening. A day in motion.',
  '["Проснулась", "Ну началось", "Интересно", "Работаю", "Неловко", "Есть!", "Перерыв", "Серьёзно?", "Домой"]'::jsonb,
  '["Morning", "Here we go", "Interesting", "Working", "Awkward", "Yes!", "Break", "Really?", "Heading home"]'::jsonb,
  '[
    "{subject} in soft morning clothes, stretching arms upward while taking a step forward, body slightly diagonal as if just getting up",
    "{subject} holding coffee cup mid-sip while phone in other hand vibrates, eyebrows slightly raised in real-time reaction",
    "{subject} turning torso 45 degrees while lowering phone slowly, processing what was just read",
    "{subject} leaning forward over laptop actively typing, shoulders engaged, focus visible through body posture",
    "{subject} briefly covering face with one hand while turning slightly away, mid-awkward reaction",
    "{subject} small contained fist pump near chest while shifting weight onto one leg, restrained but real satisfaction",
    "{subject} standing up from seated position, rolling shoulders back in visible micro-break movement",
    "{subject} stopping mid-step with phone half-lowered, subtle pause before responding",
    "{subject} pulling hoodie over head or adjusting jacket while beginning to turn away, body in motion as if leaving for home"
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
