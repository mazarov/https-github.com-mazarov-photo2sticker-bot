-- 114_sessions_pending_critic_reasons.sql
-- Test bot: store critic reasons for "Переделать" so Captions/Scenes agents receive full feedback (reasons + suggestions).

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_critic_reasons jsonb DEFAULT NULL;

COMMENT ON COLUMN sessions.pending_critic_reasons IS 'Last Critic reasons array for pack rework (test bot); passed to agents together with pending_critic_suggestions.';
