-- 105_test_after_dark_danger_close_playful_v1.sql (ТЕСТ)
-- Один пак: Опасно близко — Playful Night. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'after_dark_danger_close_playful_v1',
  'couple_v1',
  'Опасно близко — Игра',
  'Dangerously close — Playful',
  'Чуть ближе. Чуть медленнее. И не делай вид, что тебе всё равно.',
  'A little closer. A little slower. And don''t pretend you don''t care.',
  '["Подойди", "Ближе", "Сними это", "Не смотри так", "Тише", "Серьёзно?", "Почти", "Ну же", "Останься"]'::jsonb,
  '["Come closer", "Closer", "Take it off", "Don''t look at me like that", "Quiet", "Seriously?", "Almost", "Come on", "Stay"]'::jsonb,
  '[
    "{subject} in a loose partner-style shirt, framed mid-torso, playful sideways glance with a barely-there smirk",
    "{subject} chest-up framing, lightly tugging at the collar of the soft shirt as if teasingly considering unbuttoning it",
    "{subject} framed chest-up, slowly unbuttoning one button while maintaining eye contact with a half-smile",
    "{subject} waist-up framing, sliding the shirt off one shoulder with an amused expression, eyebrows slightly raised",
    "{subject} now revealing thin night top underneath, shirt hanging loose, subtle playful tilt of head",
    "{subject} chest-up framing, fingers lightly tracing collarbone while giving a mock-serious look",
    "{subject} framed chest-up, holding the loose shirt at the waist and pretending to drop it, playful suspense in eyes",
    "{subject} chest-up framing, shirt slipping further down one arm, quick teasing smile as eyes briefly look away",
    "{subject} chest-up framing, in soft nightwear or open shirt, turning slightly over shoulder with a confident playful grin"
  ]'::jsonb,
  52, true, 'romantic', 9, 'single', false, 'after_dark'
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
