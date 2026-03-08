-- 081_pack_content_sets.sql
-- Pack content sets (16-02): table + session columns for carousel flow

ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_pack_carousel';

CREATE TABLE IF NOT EXISTS pack_content_sets (
  id text PRIMARY KEY,
  pack_template_id text NOT NULL REFERENCES pack_templates(id),
  name_ru text NOT NULL,
  name_en text NOT NULL,
  carousel_description_ru text,
  carousel_description_en text,
  labels jsonb NOT NULL,
  labels_en jsonb,
  scene_descriptions jsonb NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  mood text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pack_content_sets_template ON pack_content_sets(pack_template_id);
CREATE INDEX IF NOT EXISTS idx_pack_content_sets_active ON pack_content_sets(pack_template_id, is_active) WHERE is_active = true;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_content_set_id text REFERENCES pack_content_sets(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_carousel_index int DEFAULT 0;

COMMENT ON TABLE pack_content_sets IS 'Ready-made label/scene sets per pack template; used in carousel and for preview/assemble.';
COMMENT ON COLUMN sessions.pack_content_set_id IS 'Selected content set for pack (from carousel).';
COMMENT ON COLUMN sessions.pack_carousel_index IS 'Current card index in pack carousel (0-based).';
