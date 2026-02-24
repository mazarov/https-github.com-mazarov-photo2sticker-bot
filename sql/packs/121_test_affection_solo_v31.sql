-- 121_test_affection_solo_v31.sql (ТЕСТ)
-- Один пак: Нежность 3.1 — Тепло, которое чувствуется. Только pack_content_sets_test. На проде не запускать.
-- labels = мужской вариант.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'affection_solo_v31',
  'couple_v1',
  'Нежность',
  'Affection',
  'Люблю, скучаю, иди ко мне, мой/моя, спокойной ночи. Тепло, которое чувствуется.',
  'Love you, miss you, come here, mine, good night. Warmth you can feel.',
  '["Люблю тебя", "Скучаю", "Ты моя", "Красавица", "Иди ко мне", "Горжусь тобой", "Моя", "Обнимаю", "Спокойной ночи"]'::jsonb,
  '["Love you", "Miss you", "You''re mine", "Beautiful / Handsome", "Come here", "Proud of you", "Mine", "Hug", "Good night"]'::jsonb,
  '[
    "{subject} gently leans forward and places a hand on their chest, calm warm eye contact — a sincere feeling of love",
    "{subject} takes a small step forward and slightly extends an open palm, subtly closing the distance — missing you",
    "{subject} in a soft half-profile with a confident warm half-smile, body slightly turned — you are mine",
    "{subject} gives a gentle nod and a small supportive hand gesture forward — proud of you",
    "{subject} opens their arms in motion, body leaning slightly forward — come here",
    "{subject} tilts their head slightly and looks from under their lashes with a light playful smile — beautiful / handsome",
    "{subject} slowly runs a hand along their forearm, calm deep eye contact — quiet closeness",
    "{subject} wraps their arms around their shoulders and gently leans forward, as if offering a hug",
    "{subject} softly closes their eyes and smiles, hands resting calmly near the collar or fabric — good night"
  ]'::jsonb,
  151, true, 'affection', 9, 'single', false, 'affection_support'
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
