-- 092_landing_hero_paths.sql
-- Заменяем landing_cluster на явный список путей: на каких страницах показывать пак этого пресета в Hero (pack/style/{id}/1..9).
-- Кластерные страницы — всегда photo_realistic. Остальные — смаппинг по группам/подстилям из лендинга (style-groups).

-- Новая колонка: полные пути страниц
ALTER TABLE style_presets_v2
  ADD COLUMN IF NOT EXISTS landing_hero_paths text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN style_presets_v2.landing_hero_paths IS 'Полные пути страниц, на которых в Hero показывать пак этого пресета (pack/style/{id}/1..9). Пустой массив = нигде не показывать. Один путь — только у одного пресета.';

-- Кластерные страницы: всегда photo_realistic (если пресет есть в БД)
UPDATE style_presets_v2
SET landing_hero_paths = ARRAY[
  '/', '/style', '/besplatno', '/telegram', '/bot', '/s-nadpisyu',
  '/iphone', '/animirovannye', '/android'
]::text[]
WHERE id = 'photo_realistic';

-- Удаляем старую колонку и ограничение
DROP INDEX IF EXISTS idx_style_presets_v2_landing_cluster_single;
ALTER TABLE style_presets_v2 DROP COLUMN IF EXISTS landing_cluster;

-- Дочерние страницы стилей: путь -> пресет по смаппингу (group slug + substyle slug из лендинга)
-- Формат: (path, preset_id). Для страницы группы — первый подстиль; для подстиля — его пресет.
WITH path_preset(path, preset_id) AS (
  VALUES
    -- anime
    ('/style/anime', 'anime_classic'),
    ('/style/anime/classic', 'anime_classic'),
    ('/style/anime/dark', 'anime_dark'),
    ('/style/anime/shonen', 'anime_shonen'),
    ('/style/anime/romance', 'anime_romance'),
    ('/style/anime/chibi', 'anime_chibi'),
    -- memy
    ('/style/memy', 'meme_classic'),
    ('/style/memy/classic', 'meme_classic'),
    ('/style/memy/pepe', 'meme_pepe'),
    ('/style/memy/modern', 'meme_modern'),
    ('/style/memy/reaction', 'meme_reaction'),
    -- milye
    ('/style/milye', 'cute_kawaii'),
    ('/style/milye/kawaii', 'cute_kawaii'),
    ('/style/milye/cat', 'cute_cat'),
    ('/style/milye/animal', 'cute_animal'),
    ('/style/milye/plush', 'cute_plush'),
    -- 3d
    ('/style/3d', 'cartoon_3d'),
    ('/style/3d/3d', 'cartoon_3d'),
    ('/style/3d/disney', 'tv_disney'),
    -- lyubov
    ('/style/lyubov', 'love_soft'),
    ('/style/lyubov/soft', 'love_soft'),
    ('/style/lyubov/couple', 'love_couple'),
    ('/style/lyubov/heart', 'love_heart'),
    ('/style/lyubov/passion', 'love_passion'),
    -- kotiki (cute_cat — тот же пресет, что в milye)
    ('/style/kotiki', 'cute_cat'),
    ('/style/kotiki/cat', 'cute_cat'),
    -- multfilm
    ('/style/multfilm', 'cartoon_american'),
    ('/style/multfilm/american', 'cartoon_american'),
    ('/style/multfilm/retro', 'cartoon_retro'),
    ('/style/multfilm/modern', 'cartoon_modern'),
    ('/style/multfilm/telegram', 'cartoon_telegram'),
    -- igry
    ('/style/igry', 'game_pixel'),
    ('/style/igry/pixel', 'game_pixel'),
    ('/style/igry/rpg', 'game_rpg'),
    ('/style/igry/mobile', 'game_mobile'),
    -- manhwa
    ('/style/manhwa', 'manhwa_classic'),
    ('/style/manhwa/classic', 'manhwa_classic'),
    ('/style/manhwa/romance', 'manhwa_romance'),
    ('/style/manhwa/action', 'manhwa_action'),
    -- risunok
    ('/style/risunok', 'drawn_sketch'),
    ('/style/risunok/sketch', 'drawn_sketch'),
    ('/style/risunok/watercolor', 'drawn_watercolor'),
    ('/style/risunok/ink', 'drawn_ink'),
    -- serialy (tv_disney есть также в 3d)
    ('/style/serialy', 'tv_american'),
    ('/style/serialy/american', 'tv_american'),
    ('/style/serialy/adult', 'tv_adult'),
    ('/style/serialy/kids', 'tv_kids'),
    ('/style/serialy/disney', 'tv_disney'),
    ('/style/serialy/hellish', 'tv_hellish'),
    -- russkiy
    ('/style/russkiy', 'ru_90s'),
    ('/style/russkiy/90s', 'ru_90s'),
    ('/style/russkiy/love-is', 'ru_love_is'),
    ('/style/russkiy/sovetskiy', 'ru_soviet_cartoon'),
    ('/style/russkiy/ussr', 'ru_ussr_aesthetic'),
    ('/style/russkiy/bogatyr', 'ru_bogatyr'),
    ('/style/russkiy/gopnik', 'ru_gopnik'),
    ('/style/russkiy/criminal', 'ru_criminal')
),
aggregated AS (
  SELECT preset_id, array_agg(path ORDER BY path) AS paths
  FROM path_preset
  GROUP BY preset_id
)
UPDATE style_presets_v2 sp
SET landing_hero_paths = a.paths
FROM aggregated a
WHERE sp.id = a.preset_id;

-- Индекс для быстрого поиска пресета по пути: path = any(landing_hero_paths)
CREATE INDEX IF NOT EXISTS idx_style_presets_v2_landing_hero_paths_gin
  ON style_presets_v2 USING GIN (landing_hero_paths);
