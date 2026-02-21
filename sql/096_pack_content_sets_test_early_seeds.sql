-- 096_pack_content_sets_test_early_seeds.sql
-- Заполнение pack_content_sets_test ранними наборами из docs/19-02-pack-1-content-and-ru-descriptions.md (блок «Ранние наборы»).
-- Названия name_ru/name_en — как в проде (083). Зависит от 095 (таблица pack_content_sets_test). Запускать на тестовой БД.

-- Очистка: все данные удаляются, затем загрузка заново.
TRUNCATE TABLE pack_content_sets_test;

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster
) VALUES
-- sass
(
  'sass',
  'couple_v1',
  'Сарказм',
  'Sass',
  'Ага конечно, ну да, всё ясно, очень верю.',
  'Yeah right, sure sure, totally clear, I believe you.',
  '["Ага конечно", "Ну да", "Всё ясно", "Очень верю", "Да-да", "Конечно", "Как же", "Непременно", "Ага"]'::jsonb,
  '["Yeah right", "Sure", "Totally", "I believe you", "Uh huh", "Of course", "Right", "Sure thing", "Okay"]'::jsonb,
  '["{subject} with arms crossed, one eyebrow raised, skeptical", "{subject} with sarcastic smirk, nodding slowly", "{subject} with hand on hip, unimpressed look", "{subject} with exaggerated doubtful expression", "{subject} with eye-roll pose, arms crossed", "{subject} with ironic smile, side glance", "{subject} with raised eyebrow, knowing look", "{subject} with finger to chin, fake thinking pose", "{subject} with deadpan expression, arms crossed"]'::jsonb,
  9, true, 'sarcasm', 9, 'single', false
),
-- holiday_solo
(
  'holiday_solo',
  'couple_v1',
  'Праздник',
  'Holiday',
  'С днём рождения, с 14 февраля, с годовщиной, поздравляю, за нас.',
  'Happy birthday, Happy Valentine''s, anniversary, congrats, cheers to us.',
  '["С днём рождения", "С 14 февраля", "С годовщиной", "Поздравляю", "За нас", "Любимой", "Любимому", "Праздник", "Ура"]'::jsonb,
  '["Happy birthday", "Happy Valentine''s", "Anniversary", "Congrats", "Cheers to us", "To my love", "To you", "Celebration", "Yay"]'::jsonb,
  '["{subject} holding birthday cake with both hands in front of chest, smiling at camera", "{subject} holding single red heart card or prop in front of chest, smiling", "{subject} holding glass raised in toast, anniversary pose, smiling", "{subject} both arms raised in celebration, big smile, no props", "{subject} holding one glass in cheers pose, smiling at camera", "{subject} holding bouquet of flowers with both hands, presenting toward camera", "{subject} holding gift box with both hands, surprised happy expression", "{subject} wearing party hat, hands in celebratory gesture near chest", "{subject} holding one party balloon, smiling at camera"]'::jsonb,
  10, true, 'holiday', 9, 'single', false
),
-- everyday_solo
(
  'everyday_solo',
  'couple_v1',
  'Быт и уют',
  'Everyday',
  'Домашние ситуации: спим?, где еда?, вырубайся, устал, диван, мимими.',
  'Home vibes: sleep?, where is food?, pass out, tired, couch, aww.',
  '["Спим?", "Где еда?", "Вырубайся", "Устал", "Диван", "Мимими", "Обнимашки", "Кофе?", "Тихий час"]'::jsonb,
  '["Sleep?", "Where food?", "Pass out", "Tired", "Couch", "Aww", "Cuddles", "Coffee?", "Quiet time"]'::jsonb,
  '["{subject} yawning, eyes closed, head tilted back, relaxed sleeping expression", "{subject} standing, looking slightly to the side with curious expression, as if peeking at fridge", "{subject} dozing off, eyes half-closed, relaxed smile", "{subject} slumping, exhausted tired expression, shoulders down", "{subject} wrapped in blanket, cozy content expression", "close-up of {subject} making cute kissy face at camera", "{subject} hugging pillow, cozy content smile", "{subject} holding coffee mug, taking a sip, relaxed morning expression", "{subject} lying down, resting, peaceful expression, eyes soft or closed"]'::jsonb,
  11, true, 'everyday', 9, 'single', false
),
-- reactions_solo
(
  'reactions_solo',
  'couple_v1',
  'На каждый день',
  'Daily reactions',
  'Доброе утро, скучаю, устал, голоден, на работе, спокойной ночи.',
  'Good morning, miss you, tired, hungry, at work, good night.',
  '["Доброе утро", "Скучаю", "Устал", "Голоден", "На работе", "Спокойной ночи", "Поехали", "Ок", "Привет"]'::jsonb,
  '["Good morning", "Miss you", "Tired", "Hungry", "At work", "Good night", "Lets go", "Ok", "Hey"]'::jsonb,
  '["{subject} stretching arms up, morning smile", "{subject} with hand on heart, longing expression", "{subject} with tired droopy eyes, head tilted", "{subject} rubbing stomach, hungry expression", "{subject} with laptop or phone, busy at work pose", "{subject} in pajamas, waving goodnight, cozy", "{subject} with thumbs up, ready to go", "{subject} nodding with neutral okay expression", "{subject} waving at camera, friendly hello"]'::jsonb,
  12, true, 'reactions', 9, 'single', false
),
-- thanks_solo (labels = male variant; sticker_count=9 — берём 9 подписей)
(
  'thanks_solo',
  'couple_v1',
  'Благодарность',
  'Thanks',
  'Спасибо, спасибки, выручил(а), ценю, ты лучший/лучшая.',
  'Thank you, thanks, you saved me, I appreciate, you''re the best.',
  '["Спасибо", "Спасибки", "Огромное спасибо", "Выручил", "Класс, спасибо", "Ценю", "Ты лучшая", "Обожаю"]'::jsonb,
  '["Thank you", "Thanks", "Thanks a lot", "You saved me", "Cool thanks", "I appreciate", "You''re the best", "Adore you", "Heart"]'::jsonb,
  '["{subject} smiling at camera, hands slightly at chest, grateful expression", "{subject} nodding with warm smile, relaxed pose", "{subject} with hands together in thank you gesture, sincere smile", "{subject} with relieved smile, one hand on chest", "{subject} giving thumbs up, bright smile", "{subject} with hand on heart, serious grateful look at camera", "{subject} pointing off-camera with appreciative smile", "{subject} with arms crossed, warm smile at camera", "{subject} making small heart with hands at chest, smiling"]'::jsonb,
  13, true, 'thanks', 9, 'single', false
),
-- reactions_emotions
(
  'reactions_emotions',
  'couple_v1',
  'Реакции',
  'Reactions',
  'Ого, вот это да, реально?, точно, поддерживаю, огонь, класс, ахах, идея.',
  'Wow, no way, really?, sure, support, fire, cool, haha, idea.',
  '["Ого", "Вот это да", "Реально?", "Точно", "Поддерживаю", "Огонь", "Класс", "Ахах", "Идея"]'::jsonb,
  '["Wow", "No way", "Really?", "Sure", "I support", "Fire", "Cool", "Haha", "Idea"]'::jsonb,
  '["{subject} with exaggerated surprised face, eyes wide, mouth open", "{subject} whistling impressed, raised eyebrows, looking at camera", "{subject} with skeptical raised eyebrow, arms crossed", "{subject} nodding firmly, confident expression", "{subject} giving thumbs up, serious nod", "{subject} with excited grin, fire hand gesture", "{subject} with wide smile and thumbs up", "{subject} laughing, wiping tear, casual pose", "{subject} with lightbulb gesture near head, inspired look"]'::jsonb,
  14, true, 'reactions', 9, 'single', false
),
-- affection_solo (labels = male variant)
(
  'affection_solo',
  'couple_v1',
  'Нежность',
  'Affection',
  'Люблю, скучаю, ты моя/мой, красавица/красавчик, обнимаю, целую.',
  'Love you, miss you, you''re mine, beautiful, hugs, kiss.',
  '["Люблю", "Скучаю", "Ты моя", "Красавица", "Хорошего дня", "Спокойной ночи", "Обнимаю", "Целую", "Моя"]'::jsonb,
  '["Love you", "Miss you", "You''re mine", "Beautiful", "Have a good day", "Good night", "Hugging you", "Kiss", "Mine"]'::jsonb,
  '["{subject} with hand on heart, warm smile at camera", "{subject} with soft slightly sad smile, looking at camera", "{subject} with arms slightly open, inviting warm expression", "{subject} with admiring smile, one hand near heart", "{subject} waving at camera, bright morning smile", "{subject} in relaxed pose, soft sleepy smile", "{subject} with arms open in hug gesture, warm smile", "{subject} blowing a kiss to camera, smiling", "{subject} with proud happy look, hand on chest"]'::jsonb,
  15, true, 'affection', 9, 'single', false
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
  cluster = EXCLUDED.cluster;
