-- Create separate table for AI assistant sessions
-- Moves assistant data out of sessions table for better analytics and separation of concerns

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  
  -- Dialog parameters (flat columns for easy analytics)
  goal text,                       -- User's goal (Step 0)
  style text,                      -- Chosen style (Step 2)
  emotion text,                    -- Emotion (Step 3)
  pose text,                       -- Pose / gesture (Step 4)
  sticker_text text,               -- Text on sticker (Step 5), null = no text
  confirmed boolean DEFAULT false, -- User confirmed parameters
  current_step integer DEFAULT 0,  -- Current dialog step (0-7)
  
  -- Chat history
  messages jsonb DEFAULT '[]',     -- [{role, content}]
  error_count integer DEFAULT 0,   -- Consecutive AI errors (for fallback logic)
  
  -- Photo swap
  pending_photo_file_id text,      -- Temp storage for new photo during swap flow
  
  -- Status & meta
  status text DEFAULT 'active',    -- active | completed | abandoned | error
  env text DEFAULT 'prod',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  
  CONSTRAINT assistant_sessions_valid_status CHECK (status IN ('active', 'completed', 'abandoned', 'error'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_user ON assistant_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_active ON assistant_sessions(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_env ON assistant_sessions(env);
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_created ON assistant_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_session ON assistant_sessions(session_id);

-- Comments
COMMENT ON TABLE assistant_sessions IS 'AI assistant dialog sessions - stores goals, parameters, and chat history';
COMMENT ON COLUMN assistant_sessions.goal IS 'User goal from Step 0 (e.g. fun stickers, gift for friend)';
COMMENT ON COLUMN assistant_sessions.style IS 'Chosen style from dialog (e.g. anime, cartoon)';
COMMENT ON COLUMN assistant_sessions.emotion IS 'Chosen emotion (e.g. happy, surprised)';
COMMENT ON COLUMN assistant_sessions.pose IS 'Chosen pose/gesture (e.g. peace sign, thumbs up)';
COMMENT ON COLUMN assistant_sessions.sticker_text IS 'Text to put on sticker, null if none';
COMMENT ON COLUMN assistant_sessions.messages IS 'Full chat history [{role: system|user|assistant, content: string}]';
COMMENT ON COLUMN assistant_sessions.status IS 'active=in progress, completed=confirmed+generated, abandoned=timeout/manual switch, error=3 AI failures';
