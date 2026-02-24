-- 111_test_reactions_emotions_v2.sql (ТЕСТ)
-- Один пак: Реакции 2.0 — Живые. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_emotions_v2',
  'couple_v1',
  'Реакции',
  'Reactions',
  'Ого, реально?, точно, поддерживаю, ну такое, смешно, неожиданно. Живые реакции без переигрывания.',
  'Wow, really?, sure, I''m in, meh, funny, unexpected. Natural everyday reactions.',
  '["Ого", "Вот это да", "Реально?", "Точно", "Поддерживаю", "Ну такое", "Смешно", "Неожиданно", "Серьёзно?"]'::jsonb,
  '["Wow", "No way", "Really?", "Sure", "I support", "Meh", "That''s funny", "Unexpected", "Seriously?"]'::jsonb,
  '[
    "{subject} close chest-up framing, eyebrows slightly raised with subtle half-smile of surprise, natural eye contact",
    "{subject} chest-up framing, small head tilt and quiet impressed look without wide eyes",
    "{subject} close framing, slightly squinting eyes with soft doubtful expression, one eyebrow gently raised",
    "{subject} chest-up framing, small confident nod mid-motion with relaxed mouth",
    "{subject} chest-up framing, one hand lightly touching chest with supportive warm expression",
    "{subject} chest-up framing, subtle shrug with relaxed shoulders and mild unimpressed look",
    "{subject} close framing, hand briefly covering mouth while smiling naturally",
    "{subject} chest-up framing, slight lean forward with curious focused gaze",
    "{subject} close framing, calm steady eye contact with restrained \"are you serious?\" expression"
  ]'::jsonb,
  80, true, 'reactions', 9, 'single', false, 'reactions'
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
