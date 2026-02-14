# Библиотеки — `src/lib/`

## `image-utils.ts` — Обработка изображений

### `getGreenPixelRatio(buffer)` / `chromaKeyGreen(buffer)` — legacy
Legacy/unused. Worker больше не использует chroma key — rembg удаляет фон напрямую.

### `addWhiteBorder(buffer)`
Добавляет белую рамку вокруг стикера.
Алгоритм: морфологическая дилатация альфа-канала → белый слой → композитинг.

### `addTextToSticker(stickerBuffer, text)`
Добавляет текстовый бейдж поверх стикера.
- Использует `opentype.js` для рендера текста в SVG path (без системных шрифтов)
- Шрифт: `Inter-Bold.otf`
- Авто-масштабирование: 22-36px в зависимости от длины текста
- Белый rounded badge с тёмным текстом, внизу стикера

## `alerts.ts` — Алерты и нотификации

Отправка сообщений в Telegram-канал для мониторинга.

### `sendAlert(options)`
Типы алертов:
- `generation_failed`, `generation_started`, `gemini_error`, `rembg_failed`
- `worker_error`, `api_error`, `not_enough_credits`, `paywall_shown`
- `assistant_gemini_error`, `trial_credit_granted`, `trial_credit_denied`
- `idea_generated`, `onboarding_completed`

Формат: эмодзи + тип + описание + детали + stack trace (если есть).
Ограничение: 4000 символов. Без `ALERT_CHANNEL_ID` — skip.

### `sendNotification(options)`
Бизнес-нотификации:
- `new_user`, `new_sticker`, `new_payment`, `abandoned_cart`

Поддерживает media groups (исходное фото + результат),
inline-кнопки (e.g. "Make example"), одиночные фото.

## `texts.ts` — Интернационализация (i18n)

### `getText(lang, key, replacements?)`

Получает локализованный текст по ключу.

**Источники** (в порядке приоритета):
1. Кеш в памяти (TTL 5 мин)
2. Таблица `bot_texts_new` в Supabase
3. Hardcoded fallback тексты

**Фичи**:
- Поддержка placeholder'ов: `{key}` → значение из `replacements`
- Нормализация языка: `ru`, `ru-RU`, `Russian` → `ru`
- Всё что не `ru` → `en`
- Preload при старте: `preloadTexts()`

**Ключи** (примеры):
```
start.welcome, start.need_start
photo.need_photo, photo.processing
btn.add_to_pack, btn.change_style, btn.change_emotion
emotion.choose, emotion.custom_prompt
sticker.added_to_pack
error.technical
```

## `telegram.ts` — Утилиты Telegram API

Обёртки над HTTP API Telegram (без Telegraf).
Используются в worker и support-bot, где нет контекста Telegraf.

| Функция | Описание |
|---------|----------|
| `getMe()` | Информация о боте |
| `getFilePath(fileId)` | Получить путь к файлу |
| `downloadFile(filePath)` | Скачать файл как Buffer |
| `sendMessage(chatId, text, opts)` | Отправить сообщение (HTML) |
| `editMessageText(chatId, msgId, text)` | Редактировать сообщение |
| `deleteMessage(chatId, msgId)` | Удалить сообщение |
| `sendSticker(chatId, buffer, opts)` | Отправить стикер (WebP buffer) |

## `app-config.ts` — Runtime-конфигурация

### `getAppConfig(key, defaultValue)`
Читает значение из таблицы `app_config` в Supabase.
Кеш в памяти 60 секунд. Используется для имён моделей Gemini и другой runtime-конфигурации.

## `supabase.ts` — Supabase клиент

Инициализация клиента Supabase:
- Service role key (полный доступ, без RLS)
- `persistSession: false` (серверное использование)
- Один экземпляр на процесс

## `assistant-db.ts` — CRUD для ассистента

→ Подробнее: [03-ai-assistant.md](./03-ai-assistant.md)

## `ai-chat.ts` — AI чат с function calling

→ Подробнее: [03-ai-assistant.md](./03-ai-assistant.md)

## `gemini-chat.ts` — Legacy Gemini чат

Старая реализация чата через HTML-комментарии.
Заменена на `ai-chat.ts`. Оставлена для совместимости.
