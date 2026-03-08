-- Rename all styles: self-descriptive names, unique emojis, logical sort order
-- Disable 5 overlapping/problematic styles (17 → 12 active)
-- Active styles: sort 1-12 (most universal first)
-- Inactive styles: sort 20+ (grouped by category)

-- ===== ACTIVE STYLES (12): name + emoji + sort + prompt_hint =====
-- prompt_hint = ONLY visual style (lines, colors, proportions, technique)
-- NO: sticker, border, background, composition, multi-person — handled by prompt_generator

-- 1. Telegram — flat vector, clean edges
UPDATE style_presets_v2 SET
  emoji = '✈️', name_ru = 'Телеграм', name_en = 'Telegram', sort_order = 1,
  prompt_hint = 'Flat vector cartoon illustration, simplified shapes, bold clean outlines, flat bright colors, high contrast, friendly expressive face, minimal details'
WHERE id = 'cartoon_telegram';

-- 2. Anime — classic Japanese anime
UPDATE style_presets_v2 SET
  emoji = '🎌', name_ru = 'Аниме', name_en = 'Anime', sort_order = 2,
  prompt_hint = 'Japanese anime style, clean precise linework, cel-shading, large expressive eyes with detailed reflections, stylized flowing hair'
WHERE id = 'anime_classic';

-- 3. Cartoon — bold American cartoon
UPDATE style_presets_v2 SET
  emoji = '🎨', name_ru = 'Мультяшный', name_en = 'Cartoon', sort_order = 3,
  prompt_hint = 'American cartoon style, bold black outlines, flat bright saturated colors, exaggerated proportions, large head, expressive funny face'
WHERE id = 'cartoon_american';

-- 4. Anime Romance — soft shoujo aesthetic
UPDATE style_presets_v2 SET
  emoji = '💗', name_ru = 'Аниме-романс', name_en = 'Anime Romance', sort_order = 4,
  prompt_hint = 'Shoujo anime style, soft pastel colors, dreamy sparkling eyes, delicate refined features, gentle expression, flowing soft hair'
WHERE id = 'anime_romance';

-- 5. Chibi — super-deformed proportions
UPDATE style_presets_v2 SET
  emoji = '🍡', name_ru = 'Чиби', name_en = 'Chibi', sort_order = 5,
  prompt_hint = 'Chibi anime style, super-deformed proportions, oversized head 3x body size, tiny limbs, kawaii expression, simplified round features'
WHERE id = 'anime_chibi';

-- 6. Kawaii — Japanese cute, round shapes
UPDATE style_presets_v2 SET
  emoji = '✨', name_ru = 'Каваий', name_en = 'Kawaii', sort_order = 6,
  prompt_hint = 'Japanese kawaii style, pastel pink and blue palette, round soft shapes, sparkle accents, rosy blush cheeks, cute wide eyes'
WHERE id = 'cute_kawaii';

-- 7. Kitty — cat-ear character
UPDATE style_presets_v2 SET
  emoji = '🐱', name_ru = 'Котик', name_en = 'Kitty', sort_order = 7,
  prompt_hint = 'Cute cat-ear character style, cat ears and whiskers added, playful feline expression, soft fluffy aesthetic, adorable pose'
WHERE id = 'cute_cat';

-- 8. Pastel — soft watercolor, warm pastel palette
UPDATE style_presets_v2 SET
  emoji = '🌸', name_ru = 'Пастель', name_en = 'Pastel', sort_order = 8,
  prompt_hint = 'Soft romantic watercolor style, delicate brushstrokes, warm pastel palette of blush pink peach and lavender, gentle dreamy expression, flowing delicate hair'
WHERE id = 'love_soft';

-- 9. Couple — romantic pair illustration
UPDATE style_presets_v2 SET
  emoji = '👫', name_ru = 'Парочки', name_en = 'Couple', sort_order = 9,
  prompt_hint = 'Romantic couple illustration style, warm pink tones, sweet loving atmosphere, soft warm lighting, gentle smiles, tender interaction'
WHERE id = 'love_couple';

-- 10. Manhwa — Korean webtoon digital art
UPDATE style_presets_v2 SET
  emoji = '📖', name_ru = 'Манхва', name_en = 'Manhwa', sort_order = 10,
  prompt_hint = 'Korean manhwa webtoon style, sharp well-defined features, detailed expressive eyes, clean digital coloring, smooth skin rendering'
WHERE id = 'manhwa_classic';

-- 11. Love Is — minimal comic strip
UPDATE style_presets_v2 SET
  emoji = '💑', name_ru = 'Love Is', name_en = 'Love Is', sort_order = 11,
  prompt_hint = 'Love Is comic strip style, simple cute characters, minimal clean lines, sweet romantic mood, Kim Casali inspired, soft warm colors'
WHERE id = 'ru_love_is';

-- 12. Brigada — Russian crime movie gritty style
UPDATE style_presets_v2 SET
  emoji = '🕶️', name_ru = 'Бригада', name_en = 'Brigada', sort_order = 12,
  prompt_hint = 'Russian 90s crime movie illustration, Brigada style, leather jacket, serious intense expression, cinematic dramatic lighting, gritty realistic aesthetic'
WHERE id = 'ru_criminal';

-- ===== DISABLE 5 OVERLAPPING/PROBLEMATIC STYLES =====

-- love_heart: too similar to love_soft (just "add hearts")
UPDATE style_presets_v2 SET is_active = false, sort_order = 43
WHERE id = 'love_heart';

-- manhwa_romance: too similar to manhwa_classic
UPDATE style_presets_v2 SET is_active = false, sort_order = 81
WHERE id = 'manhwa_romance';

-- cartoon_modern: overlaps with cartoon_telegram (both flat/vector)
UPDATE style_presets_v2 SET is_active = false, sort_order = 52
WHERE id = 'cartoon_modern';

-- anime_dark: dark tones + bg removal = poor sticker quality
UPDATE style_presets_v2 SET is_active = false, sort_order = 21
WHERE id = 'anime_dark';

-- ru_90s: VHS/grainy texture = pixelated stickers
UPDATE style_presets_v2 SET is_active = false, sort_order = 104
WHERE id = 'ru_90s';

-- ===== RENAME ALREADY-INACTIVE STYLES =====

-- anime
UPDATE style_presets_v2 SET
  emoji = '⚔️', name_ru = 'Сёнен', name_en = 'Shonen', sort_order = 20
WHERE id = 'anime_shonen';

-- meme
UPDATE style_presets_v2 SET
  emoji = '😤', name_ru = 'Рейдж', name_en = 'Rage', sort_order = 30
WHERE id = 'meme_classic';

UPDATE style_presets_v2 SET
  emoji = '🐸', name_ru = 'Пепе', name_en = 'Pepe', sort_order = 31
WHERE id = 'meme_pepe';

UPDATE style_presets_v2 SET
  emoji = '💀', name_ru = 'Зумер', name_en = 'Zoomer', sort_order = 32
WHERE id = 'meme_modern';

UPDATE style_presets_v2 SET
  emoji = '😱', name_ru = 'Реакция', name_en = 'Reaction', sort_order = 33
WHERE id = 'meme_reaction';

-- cute
UPDATE style_presets_v2 SET
  emoji = '🐾', name_ru = 'Зверушка', name_en = 'Animal', sort_order = 40
WHERE id = 'cute_animal';

UPDATE style_presets_v2 SET
  emoji = '🧸', name_ru = 'Плюшевый', name_en = 'Plush', sort_order = 41
WHERE id = 'cute_plush';

-- love
UPDATE style_presets_v2 SET
  emoji = '🔥', name_ru = 'Страсть', name_en = 'Passion', sort_order = 42
WHERE id = 'love_passion';

UPDATE style_presets_v2 SET
  name_ru = 'Сердечки', name_en = 'Hearts'
WHERE id = 'love_heart';

-- cartoon
UPDATE style_presets_v2 SET
  emoji = '📺', name_ru = 'Ретро-мульт', name_en = 'Retro Cartoon', sort_order = 50
WHERE id = 'cartoon_retro';

UPDATE style_presets_v2 SET
  emoji = '🧊', name_ru = '3D-мульт', name_en = '3D Cartoon', sort_order = 51
WHERE id = 'cartoon_3d';

UPDATE style_presets_v2 SET
  name_ru = 'Вектор', name_en = 'Vector'
WHERE id = 'cartoon_modern';

-- game
UPDATE style_presets_v2 SET
  emoji = '👾', name_ru = 'Пиксель', name_en = 'Pixel', sort_order = 60
WHERE id = 'game_pixel';

UPDATE style_presets_v2 SET
  emoji = '🗡️', name_ru = 'RPG', name_en = 'RPG', sort_order = 61
WHERE id = 'game_rpg';

UPDATE style_presets_v2 SET
  emoji = '📱', name_ru = 'Казуал', name_en = 'Casual', sort_order = 62
WHERE id = 'game_mobile';

-- drawn
UPDATE style_presets_v2 SET
  emoji = '✏️', name_ru = 'Скетч', name_en = 'Sketch', sort_order = 70
WHERE id = 'drawn_sketch';

UPDATE style_presets_v2 SET
  emoji = '💧', name_ru = 'Акварель', name_en = 'Watercolor', sort_order = 71
WHERE id = 'drawn_watercolor';

UPDATE style_presets_v2 SET
  emoji = '🖤', name_ru = 'Тушь', name_en = 'Ink', sort_order = 72
WHERE id = 'drawn_ink';

-- manhwa
UPDATE style_presets_v2 SET
  emoji = '💥', name_ru = 'Экшн-манхва', name_en = 'Action Manhwa', sort_order = 80
WHERE id = 'manhwa_action';

UPDATE style_presets_v2 SET
  emoji = '💕', name_ru = 'Романс-манхва', name_en = 'Romance Manhwa'
WHERE id = 'manhwa_romance';

-- tv
UPDATE style_presets_v2 SET
  emoji = '🟡', name_ru = 'Симпсоны', name_en = 'Simpsons', sort_order = 90
WHERE id = 'tv_american';

UPDATE style_presets_v2 SET
  emoji = '🔞', name_ru = 'Саус Парк', name_en = 'South Park', sort_order = 91
WHERE id = 'tv_adult';

UPDATE style_presets_v2 SET
  emoji = '🌈', name_ru = 'Гравити Фолз', name_en = 'Gravity Falls', sort_order = 92
WHERE id = 'tv_kids';

UPDATE style_presets_v2 SET
  emoji = '🏰', name_ru = 'Дисней', name_en = 'Disney', sort_order = 93
WHERE id = 'tv_disney';

UPDATE style_presets_v2 SET
  emoji = '😈', name_ru = 'Хазбин', name_en = 'Hazbin', sort_order = 94
WHERE id = 'tv_hellish';

-- russian
UPDATE style_presets_v2 SET
  emoji = '🎞️', name_ru = 'Совмульт', name_en = 'Soviet Cartoon', sort_order = 100
WHERE id = 'ru_soviet_cartoon';

UPDATE style_presets_v2 SET
  emoji = '☭', name_ru = 'Плакат СССР', name_en = 'USSR Poster', sort_order = 101
WHERE id = 'ru_ussr_aesthetic';

UPDATE style_presets_v2 SET
  emoji = '🛡️', name_ru = 'Богатырь', name_en = 'Bogatyr', sort_order = 102
WHERE id = 'ru_bogatyr';

UPDATE style_presets_v2 SET
  emoji = '🧢', name_ru = 'Пацан', name_en = 'Gopnik', sort_order = 103
WHERE id = 'ru_gopnik';

UPDATE style_presets_v2 SET
  emoji = '📼', name_ru = '90-е', name_en = '90s'
WHERE id = 'ru_90s';

UPDATE style_presets_v2 SET
  emoji = '🌑', name_ru = 'Тёмное аниме', name_en = 'Dark Anime'
WHERE id = 'anime_dark';
