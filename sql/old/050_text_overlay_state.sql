-- Add wait_text_overlay state for programmatic text overlay (no AI, no credits)
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_text_overlay';
