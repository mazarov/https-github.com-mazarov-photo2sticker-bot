-- Balance command texts
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'balance.info', '💰 Ваш баланс: {credits} кредитов\n\n1 кредит = 1 стикер'),
  ('en', 'balance.info', '💰 Your balance: {credits} credits\n\n1 credit = 1 sticker'),
  ('ru', 'btn.top_up', 'Пополнить баланс'),
  ('en', 'btn.top_up', 'Top up balance')
ON CONFLICT (lang, key) DO UPDATE SET
  text = EXCLUDED.text,
  updated_at = now();
