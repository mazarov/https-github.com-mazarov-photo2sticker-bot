-- Style examples: mark stickers as examples for their style

-- Add fields to stickers
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS is_example boolean DEFAULT false;
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS style_preset_id text;

-- Index for fast example lookups
CREATE INDEX IF NOT EXISTS idx_stickers_examples 
ON stickers (style_preset_id, is_example, created_at DESC) 
WHERE is_example = true;

-- Backfill style_preset_id from sessions for existing stickers
UPDATE stickers s
SET style_preset_id = ses.selected_style_id
FROM sessions ses
WHERE s.session_id = ses.id
  AND s.style_preset_id IS NULL
  AND ses.selected_style_id IS NOT NULL;

COMMENT ON COLUMN stickers.is_example IS 'Show as style example';
COMMENT ON COLUMN stickers.style_preset_id IS 'Style ID (denormalized from sessions)';
