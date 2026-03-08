-- 118_session_state_wait_pack_rework_feedback.sql
-- Test bot: after Critic approved, user taps "Rework" → wait for user to describe what to change (text).

ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_pack_rework_feedback';
