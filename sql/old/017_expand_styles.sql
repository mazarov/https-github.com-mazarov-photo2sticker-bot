-- Expand style presets with new styles and custom option

INSERT INTO style_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('cute', '🥰', 'Милый', 'Cute', 'cute kawaii style, soft pastel colors, round shapes, adorable', 9),
  ('animal', '🐾', 'Звери', 'Animals', 'anthropomorphic animal style, furry character, expressive', 10),
  ('meme', '😂', 'Мемы', 'Meme', 'internet meme style, exaggerated expressions, viral aesthetic', 11),
  ('minimal', '⚪', 'Минимал', 'Minimal', 'minimalist style, simple lines, few colors, clean design', 12),
  ('flat', '📐', 'Плоский', 'Flat', 'flat design style, no shadows, solid colors, geometric shapes', 13),
  ('text', '💬', 'Текст', 'Text', 'text-based sticker, bold typography, speech bubble', 14),
  ('emoji', '😊', 'Эмодзи', 'Emoji', 'emoji style, round face, simple features, expressive', 15),
  ('sketch', '✏️', 'Скетч', 'Sketch', 'pencil sketch style, hand-drawn lines, rough strokes', 16),
  ('custom', '✍️', 'Свой стиль', 'Custom style', '', 99)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  emoji = EXCLUDED.emoji,
  sort_order = EXCLUDED.sort_order;

-- Session state for custom style input
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_custom_style';

-- Localization for custom style prompt
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'style.custom_prompt', '✍️ Опишите желаемый стиль стикера:'),
  ('en', 'style.custom_prompt', '✍️ Describe the desired sticker style:')
ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text;
