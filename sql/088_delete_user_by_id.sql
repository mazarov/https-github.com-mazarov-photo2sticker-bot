DO $$
DECLARE uid uuid := 'f7db39ca-fd2f-492d-b128-7fbfd3a48b44'; t text;
BEGIN
  DELETE FROM sticker_issues  WHERE sticker_id IN (SELECT id FROM stickers WHERE user_id=uid);
  DELETE FROM sticker_ratings WHERE user_id=uid OR sticker_id IN (SELECT id FROM stickers WHERE user_id=uid);
  FOREACH t IN ARRAY ARRAY['jobs','assistant_sessions','transactions','stickers','pack_batches','sessions','notification_triggers','user_feedback','user_outreach','sticker_sets'] LOOP
    IF to_regclass(t) IS NOT NULL THEN EXECUTE format('DELETE FROM %I WHERE user_id=$1', t) USING uid; END IF;
  END LOOP;
  DELETE FROM users WHERE id=uid;
END $$;
