-- Edit sticker flow: imported stickers + replace face support

ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_edit_sticker';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_edit_action';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_edit_photo';

ALTER TABLE stickers
  ADD COLUMN IF NOT EXISTS generation_type text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS edit_replace_sticker_id uuid REFERENCES stickers(id),
  ADD COLUMN IF NOT EXISTS edit_sticker_file_id text;

COMMENT ON COLUMN stickers.generation_type IS 'Generation type: style, emotion, motion, text, replace_subject, imported';
COMMENT ON COLUMN sessions.edit_replace_sticker_id IS 'Sticker id used by edit-sticker flow for replace_face callback';
COMMENT ON COLUMN sessions.edit_sticker_file_id IS 'Temporary external sticker telegram_file_id used by edit-sticker flow';
