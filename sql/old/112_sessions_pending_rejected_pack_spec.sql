-- 112_sessions_pending_rejected_pack_spec.sql
-- Test bot: store rejected-by-Critic pack spec so admin can "Save anyway".

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_rejected_pack_spec jsonb DEFAULT NULL;

COMMENT ON COLUMN sessions.pending_rejected_pack_spec IS 'Last pack spec rejected by Critic (test bot); used by pack_admin_save_rejected to insert on demand.';
