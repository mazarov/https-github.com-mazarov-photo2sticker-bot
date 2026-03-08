-- Pack: one rembg on full preview sheet; assemble uses cleaned sheet (no per-cell rembg)
-- When true, pack_sheet_file_id points to the cleaned preview image we sent to the user.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_sheet_cleaned boolean DEFAULT false;

COMMENT ON COLUMN sessions.pack_sheet_cleaned IS 'If true, pack preview was sent with background already removed; assemble skips per-cell rembg.';
