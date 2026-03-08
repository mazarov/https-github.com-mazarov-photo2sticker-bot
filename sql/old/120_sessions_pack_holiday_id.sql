-- Pack carousel: holiday toggle (e.g. 8 March). When set, carousel shows only sets with this pack_template_id.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_holiday_id text;
COMMENT ON COLUMN sessions.pack_holiday_id IS 'When set (e.g. march_8), pack carousel shows only content sets with this pack_template_id; null = default template.';
