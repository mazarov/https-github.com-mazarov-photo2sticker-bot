-- 113_test_quiet_reactions_v1.sql (ТЕСТ)
-- Один пак: Тихие реакции. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'quiet_reactions_v1',
  'couple_v1',
  'Тихие реакции',
  'Quiet reactions',
  'Пауза. Взгляд. Лёгкая улыбка. Реакции, которые говорят без слов.',
  'Pause. A look. A subtle smile. Reactions that speak quietly.',
  '["Понятно", "Интересно", "Хм", "Ладно", "Серьёзно?", "Ясно", "Любопытно", "Допустим", "Хорошо"]'::jsonb,
  '["I see", "Interesting", "Hmm", "Alright", "Really?", "Noted", "Curious", "Fair enough", "Okay"]'::jsonb,
  '[
    "{subject} chest-up framing, slight pause with soft steady eye contact and minimal expression, calm breathing",
    "{subject} turning slightly to the side with subtle thoughtful look, one hand lightly touching chin",
    "{subject} leaning back a little with faint restrained half-smile, eyebrows relaxed",
    "{subject} adjusting sleeve slowly with quiet composed expression",
    "{subject} small head tilt with focused gaze and almost imperceptible eyebrow raise",
    "{subject} looking down briefly then back up with controlled neutral face",
    "{subject} slight forward lean as if listening carefully, lips gently pressed",
    "{subject} loosely crossing arms without tension, composed steady look",
    "{subject} soft almost invisible smile in half-turn, eyes calm and grounded"
  ]'::jsonb,
  90, true, 'reactions', 9, 'single', false, 'reactions'
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
