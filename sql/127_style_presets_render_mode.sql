ALTER TABLE style_presets_v2
ADD COLUMN IF NOT EXISTS render_mode text NOT NULL DEFAULT 'stylize';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'style_presets_v2_render_mode_check'
  ) THEN
    ALTER TABLE style_presets_v2
    ADD CONSTRAINT style_presets_v2_render_mode_check
    CHECK (render_mode IN ('stylize', 'photoreal'));
  END IF;
END $$;
