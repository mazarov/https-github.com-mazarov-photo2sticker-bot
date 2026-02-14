-- Ideas improvements: default style, last_style_id, holiday themes

-- 1. Default style flag
ALTER TABLE style_presets_v2 ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false;
UPDATE style_presets_v2 SET is_default = true WHERE id = 'cartoon_telegram';

-- 2. Last used style on user
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_style_id text;

-- 3. Holiday themes table
CREATE TABLE IF NOT EXISTS holiday_themes (
  id text PRIMARY KEY,
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  prompt_modifier text NOT NULL,
  is_active boolean DEFAULT false,
  sort_order int DEFAULT 0
);

INSERT INTO holiday_themes (id, emoji, name_ru, name_en, prompt_modifier, is_active, sort_order) VALUES
  ('valentines', '💘', 'Валентинка', 'Valentine',
   'All ideas MUST be Valentine''s Day themed — romantic gestures, love confessions, heart symbols, couple moments, cupid arrows, love letters, blushing. Make ideas sweet, flirty and festive for February 14th.',
   true, 1),
  ('march_8', '🌷', 'С 8 марта', 'Women''s Day',
   'All ideas MUST be International Women''s Day themed — flowers, spring, beauty, feminine power, gifts, celebration of women. Warm, elegant, festive mood.',
   false, 2),
  ('new_year', '🎄', 'Новый год', 'New Year',
   'All ideas MUST be New Year / Christmas themed — Santa hat, snowflakes, gifts, champagne, fireworks, cozy winter, holiday decorations. Festive and joyful mood.',
   false, 3),
  ('halloween', '🎃', 'Хэллоуин', 'Halloween',
   'All ideas MUST be Halloween themed — costumes, pumpkins, spooky fun, trick or treat, witches, ghosts, bats. Fun and playful spooky mood, not scary.',
   false, 4)
ON CONFLICT (id) DO UPDATE SET
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_modifier = EXCLUDED.prompt_modifier,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;
