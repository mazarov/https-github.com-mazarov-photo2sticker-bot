-- 083_pack_content_sets_all.sql
-- All content sets for couple_v1 from docs/16-02-pack-content-sets.md (section 3).
-- IDs: romance, everyday, humor, ... (no template prefix).

-- One-time cleanup: point sessions to new ids, then remove old content set rows
UPDATE sessions SET pack_content_set_id = 'romance'   WHERE pack_content_set_id = 'couple_v1_romance';
UPDATE sessions SET pack_content_set_id = 'everyday'  WHERE pack_content_set_id = 'couple_v1_everyday';
UPDATE sessions SET pack_content_set_id = 'humor'     WHERE pack_content_set_id = 'couple_v1_humor';
UPDATE sessions SET pack_content_set_id = 'support'   WHERE pack_content_set_id = 'couple_v1_support';
UPDATE sessions SET pack_content_set_id = 'sweet'     WHERE pack_content_set_id = 'couple_v1_sweet';
UPDATE sessions SET pack_content_set_id = 'sass'       WHERE pack_content_set_id = 'couple_v1_sass';
UPDATE sessions SET pack_content_set_id = 'reactions'  WHERE pack_content_set_id = 'couple_v1_reactions';
UPDATE sessions SET pack_content_set_id = 'holiday'    WHERE pack_content_set_id = 'couple_v1_holiday';

DELETE FROM pack_content_sets
WHERE pack_template_id = 'couple_v1'
  AND id IN ('couple_v1_romance', 'couple_v1_everyday', 'couple_v1_humor', 'couple_v1_support', 'couple_v1_sweet', 'couple_v1_sass', 'couple_v1_reactions', 'couple_v1_holiday');

-- 1. Романтика
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
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
  9,
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
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;

-- 2. Быт и уют
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
) VALUES (
  'everyday',
  'couple_v1',
  'Быт и уют',
  'Everyday',
  'Домашние ситуации: спим?, где еда?, вырубайся, устал, диван, мимими.',
  'Home vibes: sleep?, where is food?, pass out, tired, couch, aww.',
  '["Спим?", "Где еда?", "Вырубайся", "Устал", "Диван", "Мимими", "Обнимашки", "Кофе?", "Тихий час"]'::jsonb,
  '["Sleep?", "Where food?", "Pass out", "Tired", "Couch", "Aww", "Cuddles", "Coffee?", "Quiet time"]'::jsonb,
  '[
    "person on couch yawning with eyes closed, head tilted back, sleeping vibe",
    "person in kitchen standing at open fridge looking inside, curious expression",
    "person on couch dozing off, relaxed smile",
    "person exhausted slumping on sofa, tired expression",
    "person cuddling under blanket on couch, cozy",
    "close-up of person making cute kissy face at camera",
    "person hugging pillow on couch, cozy",
    "person holding coffee mug, taking a sip, morning vibe",
    "person lying on bed resting, peaceful expression"
  ]'::jsonb,
  9,
  2,
  true,
  'everyday'
) ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;

-- 2.5. Для пары (быт и уют для двух персонажей)
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
) VALUES (
  'couple_everyday',
  'couple_v1',
  'Для пары',
  'For couple',
  'Домашние ситуации для двоих: спим?, где еда?, вырубайся, устал, диван, мимими.',
  'Home vibes for two: sleep?, where is food?, pass out, tired, couch, aww.',
  '["Спим?", "Где еда?", "Вырубайся", "Устал", "Диван", "Мимими", "Обнимашки", "Кофе?", "Тихий час"]'::jsonb,
  '["Sleep?", "Where food?", "Pass out", "Tired", "Couch", "Aww", "Cuddles", "Coffee?", "Quiet time"]'::jsonb,
  '[
    "both on couch, man yawning with eyes closed, woman already dozing with head on his shoulder, sleeping vibe",
    "in kitchen, woman standing at open fridge looking inside, man behind her peeking into fridge, both standing",
    "both on couch, man dozing off, woman smiling",
    "man exhausted slumping on sofa, woman patting his head",
    "couple cuddling on couch under blanket",
    "close-up of woman making cute kissy face at camera",
    "man and woman hugging on couch, cozy",
    "man holding two coffee mugs, offering one to woman",
    "both lying on bed resting, peaceful"
  ]'::jsonb,
  9,
  2.5,
  true,
  'everyday'
) ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;

-- 3. С юмором
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
) VALUES (
  'humor',
  'couple_v1',
  'С юмором',
  'With humor',
  'Подколы: опять ты, ну привет, ну ты даёшь, выручай, кранты.',
  'Teasing: you again, well hello, oh really, help me out, done for.',
  '["Опять ты", "Ну привет", "Ну ты даёшь", "Выручай", "Кранты", "Серьёзно?", "Ну давай", "Ок ок", "Ладно"]'::jsonb,
  '["You again", "Well hello", "Oh really", "Help me", "Done for", "Seriously?", "Come on", "Ok ok", "Alright"]'::jsonb,
  '[
    "woman rolling eyes at camera, man grinning beside her",
    "man with exaggerated surprised face, woman laughing",
    "woman with hand on hip, skeptical look, man shrugging",
    "man with pleading expression, hands together",
    "both with dramatic exhausted expressions",
    "woman raising one eyebrow, unimpressed",
    "man making silly face, woman pretending to push him away",
    "both nodding with exaggerated serious faces",
    "woman with hand over man mouth, both laughing"
  ]'::jsonb,
  9,
  3,
  true,
  'humor'
) ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;

-- 4. Поддержка
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
) VALUES (
  'support',
  'couple_v1',
  'Поддержка',
  'Support',
  'Мы команда: мой герой, вместе справимся, горжусь, ты сможешь, рядом.',
  'We are a team: my hero, we got this, proud of you, you can do it, right here.',
  '["Мой герой", "Вместе справимся", "Горжусь", "Ты сможешь", "Рядом", "Верим в тебя", "Держись", "Красавчик", "Сила"]'::jsonb,
  '["My hero", "We got this", "Proud of you", "You can do it", "Right here", "We believe", "Hang in there", "You got this", "Strength"]'::jsonb,
  '[
    "man hugging woman from behind, both smiling at camera",
    "man and woman fist bump, determined smiles",
    "woman with hand on man shoulder, supportive look",
    "man encouraging expression, woman nodding",
    "couple standing close, arms around each other",
    "woman giving thumbs up to man, both smiling",
    "man with arm around woman, protective and warm",
    "close-up man confident smile",
    "both with raised fists together, team pose"
  ]'::jsonb,
  9,
  4,
  true,
  'support'
) ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;

-- 5. Ласка и комплименты
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
) VALUES (
  'sweet',
  'couple_v1',
  'Ласка и комплименты',
  'Sweet',
  'Красотка, милый, таю, обожаю, котик, солнышко.',
  'Beauty, sweetie, melting, adore you, kitty, sunshine.',
  '["Красотка", "Милый", "Таю", "Обожаю", "Котик", "Солнышко", "Сладкий", "Любимый", "Прелесть"]'::jsonb,
  '["Beauty", "Sweetie", "Melting", "Adore you", "Kitty", "Sunshine", "Sweet", "Love", "Cutie"]'::jsonb,
  '[
    "close-up portrait of woman, soft smile, gentle expression",
    "close-up portrait of man, tender look",
    "woman with hand on heart, touched expression",
    "man and woman in gentle embrace, eyes closed",
    "woman kissing man on forehead",
    "both with shy sweet smiles, leaning together",
    "woman blushing, man smiling at her",
    "couple nose to nose, playful affection",
    "woman resting head on man chest, peaceful"
  ]'::jsonb,
  9,
  5,
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
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;

-- 6. Сарказм
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
) VALUES (
  'sass',
  'couple_v1',
  'Сарказм',
  'Sass',
  'Ага конечно, ну да, всё ясно, очень верю.',
  'Yeah right, sure sure, totally clear, I believe you.',
  '["Ага конечно", "Ну да", "Всё ясно", "Очень верю", "Да-да", "Конечно", "Как же", "Непременно", "Ага"]'::jsonb,
  '["Yeah right", "Sure", "Totally", "I believe you", "Uh huh", "Of course", "Right", "Sure thing", "Okay"]'::jsonb,
  '[
    "woman with arms crossed, one eyebrow raised, skeptical",
    "man with sarcastic smirk, nodding slowly",
    "woman with hand on hip, unimpressed look",
    "man with exaggerated doubtful expression",
    "both with identical eye-roll pose",
    "woman with ironic smile, side glance",
    "man with raised eyebrow, knowing look",
    "woman with finger to chin, fake thinking pose",
    "both with deadpan expressions, arms crossed"
  ]'::jsonb,
  9,
  6,
  true,
  'sarcasm'
) ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;

-- 7. На каждый день
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
) VALUES (
  'reactions',
  'couple_v1',
  'На каждый день',
  'Daily reactions',
  'Доброе утро, скучаю, устал, голоден, на работе, спокойной ночи.',
  'Good morning, miss you, tired, hungry, at work, good night.',
  '["Доброе утро", "Скучаю", "Устал", "Голоден", "На работе", "Спокойной ночи", "Поехали", "Ок", "Привет"]'::jsonb,
  '["Good morning", "Miss you", "Tired", "Hungry", "At work", "Good night", "Lets go", "Ok", "Hey"]'::jsonb,
  '[
    "man stretching arms up, morning smile, woman beside him yawning",
    "woman with hand on heart, longing expression",
    "man with tired droopy eyes, head tilted",
    "man rubbing stomach, hungry expression, woman laughing",
    "woman with laptop or phone, busy at work pose",
    "both in pajamas, waving goodnight, cozy",
    "both with thumbs up, ready to go",
    "man nodding with neutral okay expression",
    "woman waving at camera, friendly hello"
  ]'::jsonb,
  9,
  7,
  true,
  'reactions'
) ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;

-- 8. Праздник
INSERT INTO pack_content_sets (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions, sticker_count, sort_order, is_active, mood
) VALUES (
  'holiday',
  'couple_v1',
  'Праздник',
  'Holiday',
  'С днём рождения, с 14 февраля, с годовщиной, поздравляю, за нас.',
  'Happy birthday, Happy Valentine''s, anniversary, congrats, cheers to us.',
  '["С днём рождения", "С 14 февраля", "С годовщиной", "Поздравляю", "За нас", "Любимой", "Любимому", "Праздник", "Ура"]'::jsonb,
  '["Happy birthday", "Happy Valentine''s", "Anniversary", "Congrats", "Cheers to us", "To my love", "To you", "Celebration", "Yay"]'::jsonb,
  '[
    "man holding birthday cake, woman blowing kiss",
    "couple with red hearts, Valentine theme, smiling",
    "man and woman toasting with glasses, anniversary",
    "woman with confetti, congratulatory pose",
    "both raising glasses, cheers pose",
    "man presenting flowers to woman",
    "man with gift box, woman surprised happy",
    "both with party hats or celebration props",
    "couple hugging, festive confetti around"
  ]'::jsonb,
  9,
  8,
  true,
  'holiday'
) ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sticker_count = EXCLUDED.sticker_count,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood;
