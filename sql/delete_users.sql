DO $$
DECLARE
  uid uuid := '701e4321-a440-495d-909b-1e7fadf57b84';
  t text;
BEGIN
  -- 1) Сначала удаляем зависимости от stickers
  DELETE FROM sticker_issues
  WHERE sticker_id IN (SELECT id FROM stickers WHERE user_id = uid);

  DELETE FROM sticker_ratings
  WHERE user_id = uid
     OR sticker_id IN (SELECT id FROM stickers WHERE user_id = uid);

  -- 2) Убираем FK-ссылки sessions -> stickers
  IF to_regclass('sessions') IS NOT NULL THEN
    UPDATE sessions
    SET edit_replace_sticker_id = NULL
    WHERE edit_replace_sticker_id IN (
      SELECT id FROM stickers WHERE user_id = uid
    );
  END IF;

  -- 3) Удаляем таблицы с user_id (ВАЖНО: sessions раньше stickers)
  FOREACH t IN ARRAY ARRAY[
    'jobs',
    'assistant_sessions',
    'transactions',
    'pack_batches',
    'sessions',
    'notification_triggers',
    'user_feedback',
    'user_outreach',
    'sticker_sets',
    'stickers'
  ]
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I WHERE user_id = $1', t) USING uid;
    END IF;
  END LOOP;

  -- 4) Пользователь
  DELETE FROM users WHERE id = uid;
END $$;
