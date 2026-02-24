-- 111_session_state_wait_pack_generate_request.sql
-- Add state for admin pack generation flow (test bot: user entered theme, waiting for pipeline).

ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_pack_generate_request';
