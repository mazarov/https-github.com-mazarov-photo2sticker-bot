-- Add AI assistant session states to enum
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'assistant_wait_photo';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'assistant_chat';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_assistant_confirm';
