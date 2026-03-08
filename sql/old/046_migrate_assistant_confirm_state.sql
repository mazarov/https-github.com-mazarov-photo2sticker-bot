-- Migrate existing sessions from wait_assistant_confirm to assistant_chat
-- The wait_assistant_confirm state is no longer used in the v2 function calling architecture.
-- All assistant dialog now happens in assistant_chat state.

UPDATE sessions 
SET state = 'assistant_chat' 
WHERE state = 'wait_assistant_confirm' 
  AND is_active = true;

-- Note: we keep wait_assistant_confirm in the session_state enum for backward compatibility
-- (old inactive sessions may still reference it)
