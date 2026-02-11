-- Pack Ideas: AI-generated sticker pack ideas
-- Adds columns to sessions for idea storage and navigation
-- Adds idea_source to stickers for analytics

-- Sessions: cached AI ideas
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_ideas jsonb DEFAULT NULL;
COMMENT ON COLUMN sessions.pack_ideas IS 'Cached array of StickerIdea[] from AI';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_idea_index int DEFAULT 0;
COMMENT ON COLUMN sessions.current_idea_index IS 'Current idea being shown to user';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS generated_from_ideas text[] DEFAULT '{}';
COMMENT ON COLUMN sessions.generated_from_ideas IS 'Array of idea IDs that were generated';

-- Stickers: track which idea generated this sticker
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS idea_source text DEFAULT NULL;
COMMENT ON COLUMN stickers.idea_source IS 'If sticker was generated from pack idea — stores idea ID';
