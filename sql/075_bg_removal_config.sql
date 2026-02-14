-- Configurable background removal primary service (per environment)
-- Values: "rembg" (free) or "pixian" (paid, better quality)
-- Change at runtime via Supabase — picks up within 60 seconds

-- Prod: use pixian as primary
INSERT INTO app_config (key, value) VALUES ('bg_removal_primary', 'pixian')
ON CONFLICT (key) DO UPDATE SET value = 'pixian';

-- Test: use rembg as primary (for testing new models)
INSERT INTO app_config (key, value) VALUES ('bg_removal_primary_test', 'rembg')
ON CONFLICT (key) DO UPDATE SET value = 'rembg';

-- Configurable rembg model (per environment)
-- Values: isnet-general-use, isnet-anime, birefnet-general, birefnet-portrait, bria-rmbg, u2net
-- Model downloads on first request (~30-50 sec), then cached

-- Prod: stable model
INSERT INTO app_config (key, value) VALUES ('rembg_model', 'isnet-general-use')
ON CONFLICT (key) DO UPDATE SET value = 'isnet-general-use';

-- Test: experimental model
INSERT INTO app_config (key, value) VALUES ('rembg_model_test', 'isnet-anime')
ON CONFLICT (key) DO UPDATE SET value = 'isnet-anime';
