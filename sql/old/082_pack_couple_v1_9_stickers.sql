-- 082_pack_couple_v1_9_stickers.sql
-- Couple template: 9 stickers (3×3). One content set for carousel.

UPDATE pack_templates
SET
  sticker_count = 9,
  labels = '["Моя", "Люблю", "Спим?", "Чмок", "Вместе", "Красотка", "Мой герой", "Подарок", "Навсегда"]'::jsonb,
  labels_en = '["Mine", "Love", "Sleep?", "Mwah", "Together", "Beauty", "My hero", "Gift", "Forever"]'::jsonb,
  scene_descriptions = '[
    "man hugging woman from behind, both smiling at camera",
    "man with arm around woman, both looking at camera with gentle smiles",
    "man yawning with eyes closed, woman leaning head on his shoulder sleeping",
    "woman giving a peck on the cheek to man",
    "man hugging woman from behind, both relaxed and content",
    "close-up portrait of elegant woman, serene expression",
    "close-up portrait of man with serious or thoughtful expression",
    "man holding out red gift box wrapped with white ribbon",
    "man with arm around woman, both smiling at camera, together forever"
  ]'::jsonb
WHERE id = 'couple_v1';

INSERT INTO pack_content_sets (
  id,
  pack_template_id,
  name_ru,
  name_en,
  carousel_description_ru,
  carousel_description_en,
  labels,
  labels_en,
  scene_descriptions,
  sort_order,
  is_active,
  mood
) VALUES (
  'romance',
  'couple_v1',
  'Романтика',
  'Romance',
  'Тёплые фразы: люблю, навсегда, подарок, вместе, чмок, красотка, мой герой.',
  'Warm phrases: love, forever, gift, together, mwah, beauty, my hero.',
  '["Моя", "Люблю", "Спим?", "Чмок", "Вместе", "Красотка", "Мой герой", "Подарок", "Навсегда"]'::jsonb,
  '["Mine", "Love", "Sleep?", "Mwah", "Together", "Beauty", "My hero", "Gift", "Forever"]'::jsonb,
  '[
    "man hugging woman from behind, both smiling at camera",
    "man with arm around woman, both looking at camera with gentle smiles",
    "man yawning with eyes closed, woman leaning head on his shoulder sleeping",
    "woman giving a peck on the cheek to man",
    "man hugging woman from behind, both relaxed and content",
    "close-up portrait of elegant woman, serene expression",
    "close-up portrait of man with serious or thoughtful expression",
    "man holding out red gift box wrapped with white ribbon",
    "man with arm around woman, both smiling at camera, together forever"
  ]'::jsonb,
  1,
  true,
  'romance'
) ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;
