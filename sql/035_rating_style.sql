-- Add style_preset_id to sticker_ratings for analytics

ALTER TABLE sticker_ratings ADD COLUMN IF NOT EXISTS style_preset_id text;

-- Backfill from existing stickers
UPDATE sticker_ratings sr
SET style_preset_id = s.style_preset_id
FROM stickers s
WHERE sr.sticker_id = s.id
  AND sr.style_preset_id IS NULL
  AND s.style_preset_id IS NOT NULL;

-- Index for fast analytics queries
CREATE INDEX IF NOT EXISTS idx_sticker_ratings_style 
ON sticker_ratings (style_preset_id, rating) 
WHERE rating IS NOT NULL;
