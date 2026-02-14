-- ============================================================
-- Style Preview Card: add description_ru to style_presets_v2
-- ============================================================

ALTER TABLE style_presets_v2
  ADD COLUMN IF NOT EXISTS description_ru text;

-- Fill descriptions for all active presets
UPDATE style_presets_v2 SET description_ru = 'Мультяшный стиль как в Telegram стикерах — яркие цвета, чёткие контуры, выразительные эмоции.' WHERE id = 'cartoon_telegram';
UPDATE style_presets_v2 SET description_ru = 'Классический аниме-стиль — большие глаза, тонкие линии, нежные цвета.' WHERE id = 'anime_classic';
UPDATE style_presets_v2 SET description_ru = 'Американский мультяшный стиль — как в Disney или Pixar, объёмный и детализированный.' WHERE id = 'cartoon_american';
UPDATE style_presets_v2 SET description_ru = 'Пиксельная графика в стиле ретро-игр — ностальгия по 8-bit эпохе.' WHERE id = 'pixel_art';
UPDATE style_presets_v2 SET description_ru = 'Маленький и милый — большая голова, маленькое тело, максимум няшности.' WHERE id = 'chibi';
UPDATE style_presets_v2 SET description_ru = 'Карандашный набросок — чёрно-белые штрихи, как нарисовано от руки.' WHERE id = 'sketch';
UPDATE style_presets_v2 SET description_ru = 'Акварельный стиль — мягкие переходы цветов, воздушность и нежность.' WHERE id = 'watercolor';
UPDATE style_presets_v2 SET description_ru = 'Поп-арт — яркие цвета, контрастные контуры, в стиле Энди Уорхола.' WHERE id = 'pop_art';
UPDATE style_presets_v2 SET description_ru = 'Стиль комиксов — жирные контуры, динамичные позы, speech bubbles.' WHERE id = 'comic';
UPDATE style_presets_v2 SET description_ru = '3D-стиль из пластилина/глины — объёмный, тактильный, тёплый.' WHERE id = 'clay';
UPDATE style_presets_v2 SET description_ru = 'Витражный стиль — яркие цвета в обрамлении тёмных контуров.' WHERE id = 'stained_glass';
UPDATE style_presets_v2 SET description_ru = 'Уличный стиль граффити — яркие теги, брызги краски, urban vibe.' WHERE id = 'graffiti';
