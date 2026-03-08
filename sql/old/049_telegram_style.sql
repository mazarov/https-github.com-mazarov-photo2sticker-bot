-- Add "Telegram" style to cartoon group in style_presets_v2
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('cartoon_telegram', 'cartoon', '✈️', 'Телеграм', 'Telegram', 'cartoonized vector illustration from photo, flat colors, simplified shapes, bold black outline, thick white sticker border, telegram sticker style, clean edges, high contrast, friendly expression, minimal details', 5)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;
