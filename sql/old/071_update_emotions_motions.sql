-- Update emotion_presets: remove duplicate, add 4 new, improve prompt_hints with body poses
-- Update motion_presets: replace full-body (run/dance), add coffee/phone, all "upper body"

-- ===== EMOTION PRESETS (7 → 10) =====

-- Update existing
UPDATE emotion_presets SET
  name_ru = 'Радуюсь!', name_en = 'Happy',
  prompt_hint = 'joyful expression, big open smile, eyes squinting with happiness, slightly tilted head',
  sort_order = 1
WHERE id = 'happy';

-- Remove "Тёплое настроение" (duplicate of happy)
DELETE FROM emotion_presets WHERE id = 'warm';

UPDATE emotion_presets SET
  name_ru = 'Вау!', name_en = 'Wow',
  prompt_hint = 'amazed excited expression, mouth open in awe, hands up near face, sparkling eyes',
  sort_order = 2
WHERE id = 'excited';

UPDATE emotion_presets SET
  name_ru = 'Грущу', name_en = 'Sad',
  prompt_hint = 'sad pouty expression, watery eyes, single tear on cheek, drooping shoulders',
  sort_order = 3
WHERE id = 'sad';

UPDATE emotion_presets SET
  name_ru = 'Бешусь', name_en = 'Furious',
  prompt_hint = 'furious expression, gritted teeth, furrowed brows, clenched fists near face, red cheeks',
  sort_order = 4
WHERE id = 'angry';

UPDATE emotion_presets SET
  name_ru = 'Шок!', name_en = 'Shocked',
  prompt_hint = 'extremely shocked, jaw dropped, hands on cheeks, wide eyes, gasping',
  sort_order = 5
WHERE id = 'surprised';

UPDATE emotion_presets SET
  name_ru = 'Влюблён', name_en = 'In love',
  prompt_hint = 'dreamy loving expression, hands clasped near chin, blushing cheeks, soft gaze',
  sort_order = 6
WHERE id = 'love';

-- New emotions
INSERT INTO emotion_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('sly', '😏', 'Хитрый', 'Sly', 'sly smirk, one raised eyebrow, knowing look, chin slightly down, scheming expression', 7),
  ('embarrassed', '😳', 'Стыдно', 'Embarrassed', 'blushing bright red, hand covering mouth, wide shy eyes, looking away, embarrassed', 8),
  ('sleeping', '😴', 'Сплю', 'Sleeping', 'eyes closed peacefully, head tilted to side resting on hands, serene sleeping face', 9),
  ('cringe', '🫠', 'Кринж', 'Cringe', 'cringing awkward expression, squinting one eye, teeth clenched, uncomfortable grimace', 10)
ON CONFLICT (id) DO UPDATE SET
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- Custom stays last
UPDATE emotion_presets SET sort_order = 11 WHERE id = 'custom';

-- ===== MOTION PRESETS (12 → 12, replace run/dance with coffee/phone) =====

-- Update existing with better names + "upper body" in all prompts
UPDATE motion_presets SET
  name_ru = 'Привет!', name_en = 'Waving',
  prompt_hint = 'waving hand up cheerfully, friendly open smile, greeting gesture, upper body',
  sort_order = 1
WHERE id = 'waving';

UPDATE motion_presets SET
  name_ru = 'Класс!', name_en = 'Thumbs up',
  prompt_hint = 'giving big thumbs up, confident wink, approving gesture, upper body',
  sort_order = 2
WHERE id = 'thumbs_up';

UPDATE motion_presets SET
  name_ru = 'Фейспалм', name_en = 'Facepalm',
  prompt_hint = 'facepalm, palm flat on forehead, eyes closed, exasperated sigh, upper body',
  sort_order = 3
WHERE id = 'facepalm';

UPDATE motion_presets SET
  name_ru = 'Прошу!', name_en = 'Please',
  prompt_hint = 'pleading hands pressed together, begging puppy-dog eyes, desperate expression, upper body',
  sort_order = 4
WHERE id = 'praying';

UPDATE motion_presets SET
  name_ru = 'Сила!', name_en = 'Strong',
  prompt_hint = 'flexing one arm showing bicep, proud determined face, power pose, upper body',
  sort_order = 5
WHERE id = 'flexing';

UPDATE motion_presets SET
  name_ru = 'Не знаю', name_en = 'Shrug',
  prompt_hint = 'shrugging both shoulders high, palms up, confused uncertain face, upper body',
  sort_order = 6
WHERE id = 'shrugging';

UPDATE motion_presets SET
  name_ru = 'Мир!', name_en = 'Peace',
  prompt_hint = 'peace sign with two fingers near face, playful wink, cheerful, upper body',
  sort_order = 7
WHERE id = 'peace';

UPDATE motion_presets SET
  name_ru = 'Люблю!', name_en = 'Love',
  prompt_hint = 'hands forming heart shape in front of chest, warm smile, love gesture, upper body',
  sort_order = 8
WHERE id = 'heart_hands';

UPDATE motion_presets SET
  name_ru = 'Ой!', name_en = 'Oops',
  prompt_hint = 'hands covering eyes, peeking through fingers, blushing embarrassed smile, upper body',
  sort_order = 9
WHERE id = 'covering_eyes';

UPDATE motion_presets SET
  name_ru = 'Ура!', name_en = 'Hooray',
  prompt_hint = 'celebrating arms raised up, confetti energy, ecstatic cheering face, upper body',
  sort_order = 10
WHERE id = 'celebrating';

-- Disable full-body motions (legs get cropped in sticker format)
UPDATE motion_presets SET is_active = false WHERE id IN ('running', 'dancing');

-- New motions (replace running & dancing)
INSERT INTO motion_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order, is_active) VALUES
  ('coffee', '☕', 'Кофе', 'Coffee', 'holding coffee cup with both hands, cozy sleepy smile, morning vibes, upper body', 11, true),
  ('phone', '📱', 'В телефоне', 'Scrolling', 'looking down at phone in hands, focused absorbed expression, scrolling, upper body', 12, true)
ON CONFLICT (id) DO UPDATE SET
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active;

-- Custom stays last
UPDATE motion_presets SET sort_order = 13 WHERE id = 'custom';
