-- 093_landing_content_sets_cluster_two.sql
-- В Hero на главной показывать две пилюли (два контент-пака с cluster=true).
-- Пилюли берутся из pack_content_sets: только строки с is_active=true и cluster=true.
-- Имена папок в Storage pack/content/ должны совпадать с id в этой таблице.

UPDATE pack_content_sets
SET cluster = true
WHERE is_active = true
  AND id IN ('humor', 'romance');

-- Если в Storage папки с другими id (например everyday вместо romance) — заменить id в IN (...) или выполнить:
-- UPDATE pack_content_sets SET cluster = true WHERE id = 'everyday' AND is_active = true;
