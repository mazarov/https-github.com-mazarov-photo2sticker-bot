-- Rename styles to be self-descriptive without group context
-- Focus on active styles (is_active = true)

-- anime (active: anime_classic, anime_dark, anime_romance, anime_chibi)
UPDATE style_presets_v2 SET name_ru = 'Аниме', name_en = 'Anime' WHERE id = 'anime_classic';
UPDATE style_presets_v2 SET name_ru = 'Тёмное аниме', name_en = 'Dark Anime' WHERE id = 'anime_dark';
UPDATE style_presets_v2 SET name_ru = 'Сёдзё', name_en = 'Shoujo' WHERE id = 'anime_romance';
UPDATE style_presets_v2 SET name_ru = 'Чиби', name_en = 'Chibi' WHERE id = 'anime_chibi';
UPDATE style_presets_v2 SET name_ru = 'Сёнен', name_en = 'Shonen' WHERE id = 'anime_shonen';

-- cartoon (active: cartoon_telegram, cartoon_american, cartoon_modern)
UPDATE style_presets_v2 SET name_ru = 'Телеграм', name_en = 'Telegram' WHERE id = 'cartoon_telegram';
UPDATE style_presets_v2 SET name_ru = 'Мультяшный', name_en = 'Cartoon' WHERE id = 'cartoon_american';
UPDATE style_presets_v2 SET name_ru = 'Вектор', name_en = 'Vector' WHERE id = 'cartoon_modern';
UPDATE style_presets_v2 SET name_ru = 'Ретро-мульт', name_en = 'Retro Cartoon' WHERE id = 'cartoon_retro';

-- cute (active: cute_kawaii, cute_cat)
UPDATE style_presets_v2 SET name_ru = 'Каваий', name_en = 'Kawaii' WHERE id = 'cute_kawaii';
UPDATE style_presets_v2 SET name_ru = 'Котик', name_en = 'Cat' WHERE id = 'cute_cat';
UPDATE style_presets_v2 SET name_ru = 'Зверушка', name_en = 'Animal' WHERE id = 'cute_animal';

-- love (active: love_soft, love_couple, love_heart)
UPDATE style_presets_v2 SET name_ru = 'Акварель', name_en = 'Watercolor' WHERE id = 'love_soft';
UPDATE style_presets_v2 SET name_ru = 'Парочки', name_en = 'Couple' WHERE id = 'love_couple';
UPDATE style_presets_v2 SET name_ru = 'Сердечки', name_en = 'Hearts' WHERE id = 'love_heart';

-- manhwa (active: manhwa_classic, manhwa_romance)
UPDATE style_presets_v2 SET name_ru = 'Манхва', name_en = 'Manhwa' WHERE id = 'manhwa_classic';
UPDATE style_presets_v2 SET name_ru = 'Романс-манхва', name_en = 'Romance Manhwa' WHERE id = 'manhwa_romance';
UPDATE style_presets_v2 SET name_ru = 'Экшн-манхва', name_en = 'Action Manhwa' WHERE id = 'manhwa_action';

-- russian (active: ru_90s, ru_love_is, ru_criminal)
UPDATE style_presets_v2 SET name_ru = '90-е', name_en = '90s' WHERE id = 'ru_90s';
UPDATE style_presets_v2 SET name_ru = 'Love Is', name_en = 'Love Is' WHERE id = 'ru_love_is';
UPDATE style_presets_v2 SET name_ru = 'Бригада', name_en = 'Brigada' WHERE id = 'ru_criminal';
UPDATE style_presets_v2 SET name_ru = 'Совмульт', name_en = 'Soviet Cartoon' WHERE id = 'ru_soviet_cartoon';

-- tv (all inactive but rename for consistency)
UPDATE style_presets_v2 SET name_ru = 'Симпсоны', name_en = 'Simpsons' WHERE id = 'tv_american';
UPDATE style_presets_v2 SET name_ru = 'Саус Парк', name_en = 'South Park' WHERE id = 'tv_adult';
UPDATE style_presets_v2 SET name_ru = 'Гравити Фолз', name_en = 'Gravity Falls' WHERE id = 'tv_kids';
UPDATE style_presets_v2 SET name_ru = 'Дисней', name_en = 'Disney' WHERE id = 'tv_disney';
UPDATE style_presets_v2 SET name_ru = 'Хазбин', name_en = 'Hazbin' WHERE id = 'tv_hellish';

-- meme (all inactive)
UPDATE style_presets_v2 SET name_ru = 'Мем', name_en = 'Meme' WHERE id = 'meme_classic';
UPDATE style_presets_v2 SET name_ru = 'Пепе', name_en = 'Pepe' WHERE id = 'meme_pepe';
UPDATE style_presets_v2 SET name_ru = 'Зумер-мем', name_en = 'Zoomer Meme' WHERE id = 'meme_modern';
UPDATE style_presets_v2 SET name_ru = 'Реакция', name_en = 'Reaction' WHERE id = 'meme_reaction';

-- game (all inactive)
UPDATE style_presets_v2 SET name_ru = 'Пиксель', name_en = 'Pixel' WHERE id = 'game_pixel';
UPDATE style_presets_v2 SET name_ru = 'RPG', name_en = 'RPG' WHERE id = 'game_rpg';
UPDATE style_presets_v2 SET name_ru = 'Казуал', name_en = 'Casual' WHERE id = 'game_mobile';

-- drawn (all inactive)
UPDATE style_presets_v2 SET name_ru = 'Скетч', name_en = 'Sketch' WHERE id = 'drawn_sketch';
UPDATE style_presets_v2 SET name_ru = 'Акварель-арт', name_en = 'Watercolor Art' WHERE id = 'drawn_watercolor';
UPDATE style_presets_v2 SET name_ru = 'Тушь', name_en = 'Ink' WHERE id = 'drawn_ink';
