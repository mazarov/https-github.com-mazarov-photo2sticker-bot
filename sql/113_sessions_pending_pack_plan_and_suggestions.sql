-- 113_sessions_pending_pack_plan_and_suggestions.sql
-- Test bot: store plan + critic suggestions for "Переделать" (rework one iteration).

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_pack_plan jsonb DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_critic_suggestions jsonb DEFAULT NULL;

COMMENT ON COLUMN sessions.pending_pack_plan IS 'BossPlan for pack rework (test bot); used when admin taps Rework.';
COMMENT ON COLUMN sessions.pending_critic_suggestions IS 'Last Critic suggestions array for pack rework (test bot).';
