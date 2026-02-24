-- 108_test_reactions_daily_v4.sql (ТЕСТ)
-- Один пак: На каждый день 4.0 — Живой день. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_daily_v4',
  'couple_v1',
  'На каждый день — Живой',
  'Daily reactions — Real day',
  'Проснулся, опоздал, работаю, устал, хочу есть, ну да ладно, вечер. Настоящий день без фильтров.',
  'Woke up, late, working, tired, hungry, whatever, evening. A real day, no filters.',
  '["Доброе утро", "Я ещё сплю", "Скучаю", "Работаю", "Я устал(а)", "Голоден(на)", "Погнали", "Ну ок", "Спокойной ночи"]'::jsonb,
  '["Good morning", "Still sleepy", "Miss you", "Working", "I''m tired", "Hungry", "Let''s go", "Alright", "Good night"]'::jsonb,
  '[
    "{subject} in soft home clothes, stretching both arms up dramatically while phone almost slips from hand, sleepy half-smile",
    "{subject} holding pillow tightly, rubbing one eye with exaggerated tired face, hair slightly messy",
    "{subject} casually dressed, suddenly pressing phone to chest with mock-dramatic longing expression",
    "{subject} seated with laptop, leaning forward intensely typing, brows slightly furrowed, focused energy",
    "{subject} loosening collar or running hand through hair in visible frustration, shoulders dropping",
    "{subject} holding paper food bag and quickly peeking inside with wide hungry eyes, other hand on stomach",
    "{subject} energetically throwing jacket over one shoulder mid-motion as if rushing out the door",
    "{subject} mid-shrug while holding keys loosely, eyebrows raised as if saying ''well, what can I do?''",
    "{subject} wrapped lightly in blanket, mid-yawn while giving small tired wave goodnight"
  ]'::jsonb,
  65, true, 'reactions', 9, 'single', false, 'reactions'
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
