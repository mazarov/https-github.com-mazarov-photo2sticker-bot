-- Support command localization
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'support.message', '💬 Если у вас есть вопросы, предложения или проблемы — напишите напрямую:'),
  ('en', 'support.message', '💬 If you have questions, suggestions or issues — write directly:'),
  ('ru', 'support.button', '💬 Написать в поддержку'),
  ('en', 'support.button', '💬 Contact support')
ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text;
