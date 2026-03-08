-- 090_stickers_public_url.sql
-- Public URL for sticker examples: used by landing to show style examples from DB.
-- Filled by worker when uploading is_example stickers to Supabase Storage (bucket stickers-examples).

ALTER TABLE stickers
  ADD COLUMN IF NOT EXISTS public_url text;

COMMENT ON COLUMN stickers.public_url IS 'Public HTTP URL of sticker image for landing (filled when is_example=true and file uploaded to Storage)';
