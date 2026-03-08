-- 077_pack_couple_v1_16_stickers.sql
-- Update couple_v1 template to 16 stickers with labels and scene descriptions from reference pack

UPDATE pack_templates
SET
  sticker_count = 16,
  labels = '["Моя", "Наш день", "Спим?", "Опять ты", "Люблю", "Где еда?", "Мимими", "Устал", "Твоя", "Чмок", "Злюка", "Подарок", "Вместе", "Красотка", "Мой герой", "Навсегда"]'::jsonb,
  labels_en = '["Mine", "Our day", "Sleep?", "You again", "Love", "Where''s the food?", "Mimimi", "Tired", "Yours", "Mwah", "Grumpy", "Gift", "Together", "Beauty", "My hero", "Forever"]'::jsonb,
  scene_descriptions = '[
    "man hugging woman from behind, both smiling at camera",
    "close-up of two hands holding each other",
    "man yawning with eyes closed, woman leaning head on his shoulder sleeping",
    "man with arm around woman, both looking at camera with gentle smiles",
    "man kissing woman on cheek, woman holding bouquet of red roses, both smiling",
    "man looking into open refrigerator searching for food",
    "close-up portrait of smiling woman",
    "man sitting on sofa with head on hand, tired or pensive expression",
    "man embracing woman from behind, both looking forward",
    "woman giving a peck on the cheek to man",
    "close-up portrait of woman with grumpy or pouting face",
    "man holding out red gift box wrapped with white ribbon",
    "man hugging woman from behind, both relaxed and content",
    "close-up portrait of elegant woman, serene expression",
    "close-up portrait of man with serious or thoughtful expression",
    "man with arm around woman, both smiling at camera, together forever"
  ]'::jsonb
WHERE id = 'couple_v1';
