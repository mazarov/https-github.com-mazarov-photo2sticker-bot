-- Phase B: session router schema support (flow kind, revision, UI binding)

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS flow_kind text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS session_rev integer NOT NULL DEFAULT 1;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS ui_message_id bigint;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS ui_chat_id bigint;

UPDATE sessions
SET flow_kind = CASE
  WHEN state IN (
    'wait_pack_carousel',
    'wait_pack_photo',
    'wait_pack_preview_payment',
    'generating_pack_preview',
    'wait_pack_approval',
    'processing_pack'
  ) THEN 'pack'
  WHEN state IN (
    'assistant_wait_photo',
    'assistant_wait_idea',
    'assistant_chat',
    'wait_assistant_confirm'
  ) THEN 'assistant'
  ELSE 'single'
END
WHERE flow_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_user_env_flow_active_updated
  ON sessions (user_id, env, flow_kind, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_id_user_env_flow
  ON sessions (id, user_id, env, flow_kind);

INSERT INTO app_config (key, value, description)
VALUES
  ('session_router_enabled', 'false', 'Enable session router for callback resolution'),
  ('strict_session_rev_enabled', 'false', 'Reject stale callbacks when callback rev mismatches session_rev')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = now();
