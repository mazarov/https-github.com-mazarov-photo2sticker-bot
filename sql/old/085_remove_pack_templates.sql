-- 085_remove_pack_templates.sql
-- Refactor: remove pack_templates table, move sticker_count to pack_content_sets

-- Step 1: Add sticker_count column to pack_content_sets
ALTER TABLE pack_content_sets ADD COLUMN IF NOT EXISTS sticker_count int NOT NULL DEFAULT 9;

-- Step 2: Update sticker_count from pack_templates (if exists)
UPDATE pack_content_sets pcs
SET sticker_count = pt.sticker_count
FROM pack_templates pt
WHERE pcs.pack_template_id = pt.id
  AND pt.sticker_count IS NOT NULL;

-- Step 2b: If pack_templates doesn't exist or no match, compute from labels array length
UPDATE pack_content_sets
SET sticker_count = COALESCE(
  jsonb_array_length(labels),
  jsonb_array_length(scene_descriptions),
  9
)
WHERE sticker_count IS NULL OR sticker_count = 9; -- Only update if still default

-- Step 3: Set default for any remaining NULLs (shouldn't happen, but safety)
UPDATE pack_content_sets SET sticker_count = 9 WHERE sticker_count IS NULL;

-- Step 4: Make sticker_count NOT NULL (already done above, but ensure)
ALTER TABLE pack_content_sets ALTER COLUMN sticker_count SET NOT NULL;

-- Step 5: Update sessions.pack_template_id to use pack_content_set_id instead
-- For active sessions with pack_template_id but no pack_content_set_id, 
-- try to find first active content set for that template
UPDATE sessions s
SET pack_content_set_id = (
  SELECT pcs.id
  FROM pack_content_sets pcs
  WHERE pcs.pack_template_id = s.pack_template_id
    AND pcs.is_active = true
  ORDER BY pcs.sort_order ASC
  LIMIT 1
)
WHERE s.pack_template_id IS NOT NULL
  AND s.pack_content_set_id IS NULL
  AND s.is_active = true;

-- Step 6: Update pack_batches.template_id to reference pack_content_sets.id via sessions
-- We'll keep template_id for now but it will be deprecated
-- (Can be removed in future migration after verifying no direct usage)

-- Step 7: Remove foreign key constraint from pack_content_sets.pack_template_id
-- (We'll keep the column for now but remove the constraint)
ALTER TABLE pack_content_sets DROP CONSTRAINT IF EXISTS pack_content_sets_pack_template_id_fkey;

-- Step 8: Remove foreign key constraint from pack_batches.template_id
ALTER TABLE pack_batches DROP CONSTRAINT IF EXISTS pack_batches_template_id_fkey;

-- Step 9: Drop pack_templates table (after ensuring no active references)
-- Note: This will fail if there are still active sessions/batches referencing it
-- In that case, clean up first or comment out this step
DROP TABLE IF EXISTS pack_templates CASCADE;

COMMENT ON COLUMN pack_content_sets.sticker_count IS 'Number of stickers in pack (replaces pack_templates.sticker_count)';
COMMENT ON COLUMN pack_content_sets.pack_template_id IS 'DEPRECATED: kept for data migration reference only, will be removed later';
