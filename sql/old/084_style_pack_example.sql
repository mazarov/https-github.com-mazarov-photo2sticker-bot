-- 084_style_pack_example.sql
-- Pack example image per style (shown in pack style selection, separate from single-sticker examples).

ALTER TABLE style_presets_v2
  ADD COLUMN IF NOT EXISTS pack_example_file_id text;

COMMENT ON COLUMN style_presets_v2.pack_example_file_id IS 'Telegram file_id of pack preview image to show as example for this style in pack flow';
