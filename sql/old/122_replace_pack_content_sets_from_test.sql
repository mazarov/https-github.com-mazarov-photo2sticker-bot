-- 122_replace_pack_content_sets_from_test.sql
-- Prod/Test rollout: replace current pack_content_sets with the latest sets from pack_content_sets_test.
-- Safe behavior:
-- - If pack_content_sets_test table is missing, migration does nothing (NOTICE).
-- - Sessions FK is cleared before replace to avoid FK violations.

DO $$
BEGIN
  IF to_regclass('public.pack_content_sets_test') IS NULL THEN
    RAISE NOTICE 'pack_content_sets_test does not exist; skip replacement';
    RETURN;
  END IF;

  -- Avoid FK violations: sessions.pack_content_set_id -> pack_content_sets.id
  UPDATE sessions
  SET pack_content_set_id = NULL
  WHERE pack_content_set_id IS NOT NULL;

  DELETE FROM pack_content_sets;

  INSERT INTO pack_content_sets (
    id,
    pack_template_id,
    name_ru,
    name_en,
    carousel_description_ru,
    carousel_description_en,
    labels,
    labels_en,
    scene_descriptions,
    sort_order,
    is_active,
    mood,
    created_at,
    sticker_count,
    subject_mode,
    cluster,
    segment_id
  )
  SELECT
    id,
    pack_template_id,
    name_ru,
    name_en,
    carousel_description_ru,
    carousel_description_en,
    labels,
    labels_en,
    scene_descriptions,
    sort_order,
    is_active,
    mood,
    COALESCE(created_at, now()),
    COALESCE(sticker_count, 16),
    COALESCE(subject_mode, 'any'),
    COALESCE(cluster, false),
    COALESCE(segment_id, 'home')
  FROM pack_content_sets_test;
END $$;
