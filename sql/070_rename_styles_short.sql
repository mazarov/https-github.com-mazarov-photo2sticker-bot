-- Rename all styles: self-descriptive names, unique emojis, logical sort order
-- Disable 5 overlapping/problematic styles (17 → 12 active)
-- Active styles: sort 1-12 (most universal first)
-- Inactive styles: sort 20+ (grouped by category)

-- ===== ACTIVE STYLES (12) =====

-- 1. Telegram — native platform style, best for new users
UPDATE style_presets_v2 SET
  emoji = '✈️', name_ru = 'Телеграм', name_en = 'Telegram', sort_order = 1
WHERE id = 'cartoon_telegram';

-- 2. Anime — most popular sticker style
UPDATE style_presets_v2 SET
  emoji = '🎌', name_ru = 'Аниме', name_en = 'Anime', sort_order = 2
WHERE id = 'anime_classic';

-- 3. Cartoon — universal appeal
UPDATE style_presets_v2 SET
  emoji = '🎨', name_ru = 'Мультяшный', name_en = 'Cartoon', sort_order = 3
WHERE id = 'cartoon_american';

-- 4. Anime Romance (shoujo) — popular with young audience
UPDATE style_presets_v2 SET
  emoji = '💗', name_ru = 'Аниме-романс', name_en = 'Anime Romance', sort_order = 4
WHERE id = 'anime_romance';

-- 5. Chibi — very sticker-friendly (big head, small body)
UPDATE style_presets_v2 SET
  emoji = '🍡', name_ru = 'Чиби', name_en = 'Chibi', sort_order = 5
WHERE id = 'anime_chibi';

-- 6. Kawaii — cute sparkly style
UPDATE style_presets_v2 SET
  emoji = '✨', name_ru = 'Каваий', name_en = 'Kawaii', sort_order = 6
WHERE id = 'cute_kawaii';

-- 7. Kitty — cat character, internet favorite
UPDATE style_presets_v2 SET
  emoji = '🐱', name_ru = 'Котик', name_en = 'Kitty', sort_order = 7
WHERE id = 'cute_cat';

-- 8. Pastel — soft romantic watercolor, warm pastel palette
UPDATE style_presets_v2 SET
  emoji = '🌸', name_ru = 'Пастель', name_en = 'Pastel', sort_order = 8
WHERE id = 'love_soft';

-- 9. Couple — romantic pair, unique use case for 2-person photos
UPDATE style_presets_v2 SET
  emoji = '👫', name_ru = 'Парочки', name_en = 'Couple', sort_order = 9
WHERE id = 'love_couple';

-- 10. Manhwa — Korean webtoon, growing trend
UPDATE style_presets_v2 SET
  emoji = '📖', name_ru = 'Манхва', name_en = 'Manhwa', sort_order = 10
WHERE id = 'manhwa_classic';

-- 11. Love Is — iconic comic strip
UPDATE style_presets_v2 SET
  emoji = '💑', name_ru = 'Love Is', name_en = 'Love Is', sort_order = 11
WHERE id = 'ru_love_is';

-- 12. Brigada — Russian crime movie aesthetic
UPDATE style_presets_v2 SET
  emoji = '🕶️', name_ru = 'Бригада', name_en = 'Brigada', sort_order = 12
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
