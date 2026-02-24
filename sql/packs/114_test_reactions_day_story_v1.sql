-- 114_test_reactions_day_story_v1.sql (ТЕСТ)
-- Один пак: Реакции — Один день. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_day_story_v1',
  'couple_v1',
  'Реакции — Один день',
  'Reactions — One day',
  'Утро, работа, неловкость, победа, усталость и вечер. Реакции внутри одного дня.',
  'Morning, work, awkward moment, small win, tired evening. One real day.',
  '["Доброе утро", "Собираюсь", "Ну началось", "Работаю", "Неловко", "Есть!", "Устал(а)", "Серьёзно?", "Домой"]'::jsonb,
  '["Morning", "Getting ready", "Here we go", "Working", "Awkward", "Yes!", "Tired", "Really?", "Home"]'::jsonb,
  '[
    "{subject} in soft morning clothes, stretching upward while still slightly sleepy",
    "{subject} mid-motion putting on jacket or adjusting shirt as if rushing out",
    "{subject} holding coffee cup while glancing at phone with mild ''here we go'' expression",
    "{subject} leaning forward over laptop actively typing with focused energy",
    "{subject} pausing mid-step and covering part of face briefly in light awkward reaction",
    "{subject} small contained fist pump near chest with restrained satisfied smile",
    "{subject} loosening collar or dropping shoulders visibly after long day",
    "{subject} stopping mid-walk with raised eyebrows while looking at phone again",
    "{subject} wrapping lightly in jacket or hoodie while turning slightly as if heading home"
  ]'::jsonb,
  110, true, 'reactions', 9, 'single', false, 'reactions'
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
