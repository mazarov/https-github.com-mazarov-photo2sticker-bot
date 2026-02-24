-- 109_test_reactions_daily_v41.sql (ТЕСТ)
-- Один пак: На каждый день 4.1 — Ближе и живее. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_daily_v41',
  'couple_v1',
  'На каждый день',
  'Daily reactions',
  'Утро, работа, усталость, голод, дела и вечер. Обычный день — но по-настоящему живой.',
  'Morning, work, tired, hungry, errands and night. A real day, but closer.',
  '["Доброе утро", "Я ещё сплю", "Скучаю", "Работаю", "Устал(а)", "Голоден(на)", "Погнали", "Ну ок", "Спокойной ночи"]'::jsonb,
  '["Good morning", "Still sleepy", "Miss you", "Working", "Tired", "Hungry", "Let''s go", "Alright", "Good night"]'::jsonb,
  '[
    "{subject} close chest-up framing, stretching upward with relaxed smile, phone loosely in one hand, minimal empty space above head",
    "{subject} chest-up framing, holding pillow near chest, gently rubbing one eye with soft sleepy expression, natural face",
    "{subject} close framing, holding phone near heart with subtle warm smile and calm eye contact",
    "{subject} slightly wider chest-up framing, leaning forward over laptop in focused typing motion, brows slightly engaged",
    "{subject} chest-up framing, adjusting collar or brushing hair back with visible but restrained tired expression",
    "{subject} closer chest-up framing, gently opening paper bag and glancing inside with mild curious half-smile, one hand lightly resting on stomach",
    "{subject} chest-up framing mid-motion, throwing jacket over one shoulder with energetic but natural expression",
    "{subject} chest-up framing, slight shrug with keys loosely in hand, relaxed eyebrows and soft \"what can you do\" look",
    "{subject} close chest-up framing, lightly wrapped in blanket, mid-yawn with calm gentle wave, minimal background space"
  ]'::jsonb,
  70, true, 'reactions', 9, 'single', false, 'reactions'
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
