-- 112_test_reactions_emotions_v3.sql (ТЕСТ)
-- Один пак: Реакции 3.0 — В течение дня. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_emotions_v3',
  'couple_v1',
  'Реакции',
  'Reactions',
  'Удивился, задумался, поддержал, не поверил, рассмеялся. Реакции как в реальном дне.',
  'Surprised, thinking, supporting, doubtful, laughing. Reactions from a real day.',
  '["Ого", "Вот это да", "Реально?", "Точно", "Поддерживаю", "Ну такое", "Смешно", "Неожиданно", "Серьёзно?"]'::jsonb,
  '["Wow", "No way", "Really?", "Sure", "I support", "Meh", "That''s funny", "Unexpected", "Seriously?"]'::jsonb,
  '[
    "{subject} chest-up framing, holding phone slightly away while leaning back a bit with raised brows in mild surprise",
    "{subject} chest-up framing, turning slightly sideways while rereading something on phone with quiet impressed smile",
    "{subject} leaning forward closer to camera as if double-checking a message, eyes focused with subtle doubt",
    "{subject} mid-motion small nod while putting phone down, calm confident expression",
    "{subject} one hand resting lightly on chest while giving supportive steady look, slight forward lean",
    "{subject} subtle shrug while setting phone aside on imaginary surface, relaxed unimpressed face",
    "{subject} covering mouth briefly while laughing naturally, shoulders slightly lifted",
    "{subject} pausing mid-step while holding jacket in hand, curious look as if something unexpected happened",
    "{subject} crossing arms loosely and tilting head with restrained \"are you serious?\" expression"
  ]'::jsonb,
  85, true, 'reactions', 9, 'single', false, 'reactions'
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
