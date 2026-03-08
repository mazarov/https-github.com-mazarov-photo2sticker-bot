-- AI Assistant: new columns for sessions
-- Stores chat history and extracted parameters

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS assistant_messages jsonb DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS assistant_params jsonb DEFAULT null;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS assistant_error_count integer DEFAULT 0;

COMMENT ON COLUMN sessions.assistant_messages IS 'Chat history with AI assistant [{role, content}]';
COMMENT ON COLUMN sessions.assistant_params IS 'Extracted params {style, emotion, pose} from assistant dialog';
COMMENT ON COLUMN sessions.assistant_error_count IS 'Consecutive Gemini errors in this session (for fallback logic)';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_photo_file_id text DEFAULT null;
COMMENT ON COLUMN sessions.pending_photo_file_id IS 'Temporary storage for new photo file_id during assistant dialog (used for photo swap flow)';
