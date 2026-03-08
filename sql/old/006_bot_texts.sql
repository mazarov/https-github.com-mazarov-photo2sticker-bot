-- Bot texts table for localization
-- Replaces hardcoded texts with database-driven localization

create table if not exists bot_texts_new (
  id uuid primary key default gen_random_uuid(),
  lang text not null,
  key text not null,
  text text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(lang, key)
);

create index if not exists bot_texts_new_lang_key_idx on bot_texts_new (lang, key);

-- Russian texts
INSERT INTO bot_texts_new (lang, key, text) VALUES
-- Start / Greeting
('ru', 'start.greeting_new', 'Привет! 🎨

Я превращаю фото в стикеры.
Тебе начислен 1 бесплатный кредит.

Пришли фото, из которого сделать стикер.'),
('ru', 'start.greeting_return', 'С возвращением! 🎨

Твой баланс: {credits} кредитов.

Пришли фото, из которого сделать стикер.'),
('ru', 'start.need_start', 'Нажми /start чтобы начать.'),

-- Photo flow
('ru', 'photo.ask_style', 'Отлично! Теперь опиши стиль стикера (например: мульт, 3D, акварель, аниме).'),
('ru', 'photo.need_photo', 'Сначала пришли фото.'),
('ru', 'photo.processing', '🔄 Обрабатываю запрос...'),
('ru', 'photo.invalid_style', '❌ Не удалось распознать стиль.

Опиши визуальный стиль стикера, например:
• аниме
• мультяшный
• симпсоны
• 3D
• пиксель арт
• chibi, грустный'),
('ru', 'photo.not_enough_credits', '❌ Недостаточно кредитов!

Нужно: {needed} кредит(ов)
У тебя: {balance} кредит(ов)

Пополни баланс, чтобы продолжить.'),
('ru', 'photo.generation_started', '✨ Принял! Генерирую стикер, это займет немного времени...'),
('ru', 'photo.generation_continue', '✨ Продолжаю генерацию стикера...'),

-- Payment
('ru', 'payment.balance', '💳 Ваш баланс: {credits} кредитов

1 стикер = 1 кредит
Пополните баланс через Telegram Stars ⭐'),
('ru', 'payment.success', '✅ Оплата прошла успешно!

Начислено: {amount} кредитов
Новый баланс: {balance} кредитов'),
('ru', 'payment.need_more', 'Для генерации нужно ещё {needed} кредит(ов).
Пополни баланс или отправь /start для новой сессии.'),
('ru', 'payment.canceled', 'Отменено. Можешь изменить описание стиля или пополнить баланс позже.'),
('ru', 'payment.invalid_pack', 'Неверный пакет.'),
('ru', 'payment.error_create', 'Ошибка создания платежа. Попробуй позже.'),
('ru', 'payment.error_invoice', 'Ошибка отправки счёта. Попробуй позже.'),
('ru', 'payment.transaction_not_found', 'Транзакция не найдена или уже обработана.'),
('ru', 'payment.invoice_title', '{credits} кредитов'),
('ru', 'payment.invoice_description', 'Пополнение баланса на {credits} кредитов'),
('ru', 'payment.invoice_label', 'Кредиты'),

-- Processing / Results
('ru', 'processing.done', 'Готово! Вот ваш стикерпак: {link}'),
('ru', 'processing.error', '❌ Произошла ошибка при генерации стикера.

Кредиты возвращены на баланс.
Попробуй ещё раз: /start'),

-- Buttons
('ru', 'btn.cancel', '❌ Отмена'),
('ru', 'btn.canceled', 'Отменено'),

-- Sticker pack
('ru', 'sticker.pack_title', 'Мои стикеры'),

-- English texts
-- Start / Greeting
('en', 'start.greeting_new', 'Hello! 🎨

I turn photos into stickers.
You''ve received 1 free credit.

Send a photo to make a sticker.'),
('en', 'start.greeting_return', 'Welcome back! 🎨

Your balance: {credits} credits.

Send a photo to make a sticker.'),
('en', 'start.need_start', 'Press /start to begin.'),

-- Photo flow
('en', 'photo.ask_style', 'Great! Now describe the sticker style (e.g.: cartoon, 3D, watercolor, anime).'),
('en', 'photo.need_photo', 'Send a photo first.'),
('en', 'photo.processing', '🔄 Processing request...'),
('en', 'photo.invalid_style', '❌ Could not recognize the style.

Describe a visual style, for example:
• anime
• cartoon
• simpsons
• 3D
• pixel art
• chibi, sad'),
('en', 'photo.not_enough_credits', '❌ Not enough credits!

Needed: {needed} credit(s)
You have: {balance} credit(s)

Top up your balance to continue.'),
('en', 'photo.generation_started', '✨ Got it! Generating sticker, it will take a moment...'),
('en', 'photo.generation_continue', '✨ Continuing sticker generation...'),

-- Payment
('en', 'payment.balance', '💳 Your balance: {credits} credits

1 sticker = 1 credit
Top up via Telegram Stars ⭐'),
('en', 'payment.success', '✅ Payment successful!

Added: {amount} credits
New balance: {balance} credits'),
('en', 'payment.need_more', 'You need {needed} more credit(s) for generation.
Top up or send /start for a new session.'),
('en', 'payment.canceled', 'Canceled. You can change the style description or top up later.'),
('en', 'payment.invalid_pack', 'Invalid package.'),
('en', 'payment.error_create', 'Error creating payment. Try again later.'),
('en', 'payment.error_invoice', 'Error sending invoice. Try again later.'),
('en', 'payment.transaction_not_found', 'Transaction not found or already processed.'),
('en', 'payment.invoice_title', '{credits} credits'),
('en', 'payment.invoice_description', 'Top up balance with {credits} credits'),
('en', 'payment.invoice_label', 'Credits'),

-- Processing / Results
('en', 'processing.done', 'Done! Here''s your sticker pack: {link}'),
('en', 'processing.error', '❌ An error occurred during sticker generation.

Credits have been refunded.
Try again: /start'),

-- Buttons
('en', 'btn.cancel', '❌ Cancel'),
('en', 'btn.canceled', 'Canceled'),

-- Sticker pack
('en', 'sticker.pack_title', 'My Stickers')

ON CONFLICT (lang, key) DO UPDATE SET
  text = EXCLUDED.text,
  updated_at = now();
