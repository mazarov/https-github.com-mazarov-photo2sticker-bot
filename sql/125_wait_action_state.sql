-- Add wait_action and wait_replace_face_sticker for action menu flow
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_action';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_replace_face_sticker';
