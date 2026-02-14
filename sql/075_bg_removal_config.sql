-- Configurable background removal primary service
-- Values: "rembg" (default, free) or "pixian" (paid, better quality)
-- Change at runtime via Supabase — picks up within 60 seconds

INSERT INTO app_config (key, value) VALUES ('bg_removal_primary', 'pixian')
ON CONFLICT (key) DO UPDATE SET value = 'pixian';
