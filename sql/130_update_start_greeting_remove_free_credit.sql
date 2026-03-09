-- Update /start greeting: remove free-credit message, keep capability-focused onboarding copy

INSERT INTO bot_texts_new (lang, key, text)
VALUES
  (
    'ru',
    'start.greeting_new',
    'Привет! 🎨

Я умею:
• делать стикеры из фото
• менять стиль, эмоцию и движение
• удалять фон и заменять лицо

Пришли фото, чтобы начать.'
  ),
  (
    'en',
    'start.greeting_new',
    'Hello! 🎨

I can:
• turn photos into stickers
• change style, emotion, and pose
• remove background and swap faces

Send a photo to start.'
  )
ON CONFLICT (lang, key)
DO UPDATE SET
  text = EXCLUDED.text,
  updated_at = now();
