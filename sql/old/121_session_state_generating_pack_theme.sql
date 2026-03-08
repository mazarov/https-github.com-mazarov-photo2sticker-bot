-- 121_session_state_generating_pack_theme.sql
-- Admin theme flow: set this state before runPackGenerationPipeline so duplicate message deliveries don't start a second run.

ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'generating_pack_theme';
