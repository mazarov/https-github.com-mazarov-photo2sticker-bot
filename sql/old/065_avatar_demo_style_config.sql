-- Add configurable avatar demo style to app_config
-- Default: cartoon_telegram (from style_presets_v2)
-- Previously hardcoded as anime_classic in index.ts

INSERT INTO app_config (key, value, description) VALUES
  ('avatar_demo_style', 'cartoon_telegram', 'Стиль по умолчанию для демо-генерации из аватарки нового юзера')
ON CONFLICT (key) DO NOTHING;
