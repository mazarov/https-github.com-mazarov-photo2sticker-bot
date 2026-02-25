-- Show couple_v1 pack sets for both 1 and 2 people (single + multi).
-- Without this, when subject_mode_pack_filter_enabled=true and user has 2 people (multi),
-- filterPackContentSetsBySubjectMode keeps only sets with subject_mode IN ('multi','any'),
-- so all sets with subject_mode='single' disappear and user sees "Нет совместимых наборов".

UPDATE pack_content_sets
SET subject_mode = 'any'
WHERE pack_template_id = 'couple_v1'
  AND (subject_mode IS NULL OR subject_mode = 'single');
