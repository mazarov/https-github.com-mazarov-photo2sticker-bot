-- Pack: store cleaned preview sheet in Supabase Storage for assemble (keeps transparency)
-- When set, worker downloads sheet from Storage instead of Telegram file_id (avoids re-encode / opaque background).

ALTER TABLE pack_batches ADD COLUMN IF NOT EXISTS cleaned_sheet_storage_path text;

COMMENT ON COLUMN pack_batches.cleaned_sheet_storage_path IS 'Path in Storage (e.g. pack_sheets/<id>.png). Assemble uses this if set; else Telegram pack_sheet_file_id.';
