-- Improve Valentine/broadcast style hints to avoid background clutter
-- Problems fixed: "heart decorations", "floating hearts", "sparkles and bubbles" → scattered elements
-- Solution: restrict decorations to character design only, no background elements

UPDATE style_presets_v2
SET prompt_hint = 'Love Is comic strip style, simple cute couple, minimal lines, sweet romantic. Tiny heart motifs only as part of character design or composition, no background decorations.'
WHERE id = 'ru_love_is';

UPDATE style_presets_v2
SET prompt_hint = 'Romantic sticker style, pink and red palette, sweet expression. Small heart accents on clothing or accessories only. Clean composition.'
WHERE id = 'love_heart';

UPDATE style_presets_v2
SET prompt_hint = 'Romantic couple style, two characters close together, loving gaze, holding hands or hugging. Warm pink tones, both fully rendered.'
WHERE id = 'love_couple';

UPDATE style_presets_v2
SET prompt_hint = 'Soft romantic style, watercolor effect, warm pink tones, dreamy gentle expression. No floating elements, clean atmosphere.'
WHERE id = 'love_soft';

UPDATE style_presets_v2
SET prompt_hint = 'Shoujo anime style, soft pastel colors, dreamy eyes, delicate features. Subtle sparkles as eye highlights only, no background clutter.'
WHERE id = 'anime_romance';
