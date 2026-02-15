-- 078_gemini_image_size_pack.sql
-- Resolution for pack preview image (Gemini imageConfig.imageSize): 1K (1024), 2K, 4K

INSERT INTO app_config (key, value, description) VALUES
  ('gemini_image_size_pack', '1K', 'Pack preview image resolution: 1K (1024), 2K, or 4K')
ON CONFLICT (key) DO NOTHING;
