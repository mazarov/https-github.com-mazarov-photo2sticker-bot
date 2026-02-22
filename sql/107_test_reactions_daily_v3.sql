-- 107_test_reactions_daily_v3.sql (ТЕСТ)
-- Один пак: На каждый день 3.0. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_daily_v3',
  'couple_v1',
  'На каждый день',
  'Daily reactions',
  'Утро, работа, устал, хочу есть, погнали, вечер, ночь. Один день — девять состояний.',
  'Morning, work, tired, hungry, let''s go, evening, night. One day — nine moods.',
  '["Доброе утро ☀️", "Я ещё сплю", "Скучаю", "Я на работе", "Я устал(а)", "Я голоден(на)", "Погнали", "Ну ок", "Спокойной ночи 🌙"]'::jsonb,
  '["Good morning ☀️", "Still sleepy", "Miss you", "At work", "I''m tired", "I''m hungry", "Let''s go", "Alright", "Good night 🌙"]'::jsonb,
  '[
    "{subject} in soft morning shirt, stretching upward while holding a phone in other hand, sleepy smile",
    "{subject} in loose home clothes, rubbing eyes while holding pillow against chest",
    "{subject} casually dressed, holding phone near heart with soft longing expression",
    "{subject} in work outfit or shirt, focused posture with laptop or tablet slightly visible",
    "{subject} loosening collar or adjusting hair, shoulders slightly dropped in tired gesture",
    "{subject} holding snack or takeout bag playfully touching stomach with exaggerated hunger face",
    "{subject} wearing jacket or hoodie, putting one arm through sleeve energetically as if about to leave",
    "{subject} slight shrug while holding keys or phone, relaxed neutral half-smile",
    "{subject} in soft evening clothes, wrapped lightly in blanket, gentle wave with calm night expression"
  ]'::jsonb,
  60, true, 'reactions', 9, 'single', false, 'reactions'
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
