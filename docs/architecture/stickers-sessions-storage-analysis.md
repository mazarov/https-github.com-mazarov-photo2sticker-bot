# Хранение стикеров и паков: sessions vs stickers

## Текущая схема

### Где что лежит

| Данные | Таблица/колонка | Описание |
|--------|-----------------|----------|
| **Текущее фото сессии** | `sessions.current_photo_file_id` | Одно фото для single/assistant |
| **Фото в сессии (пак, ассистент)** | `sessions.photos` (jsonb) | Массив Telegram file_id |
| **Последний стикер (single/assistant)** | `sessions.last_sticker_file_id` | Telegram file_id |
| **Путь последнего стикера в Storage** | `sessions.last_sticker_storage_path` | Путь в bucket `stickers` |
| **Превью-лист пака** | `sessions.pack_sheet_file_id` | Telegram file_id листа |
| **Очищенный лист пака в Storage** | `pack_batches.cleaned_sheet_storage_path` | Путь в Storage (если есть) |
| **Каждый сгенерированный стикер** | `stickers` | Строка на стикер: telegram_file_id, result_storage_path, session_id, pack_batch_id+pack_index |

### Как отличить пак от одиночного стикера

**В таблице `stickers`:**
- **Одиночный стикер (single/assistant):** `pack_batch_id IS NULL`, `pack_index` не используется.
- **Стикер из пака:** `pack_batch_id IS NOT NULL`, `pack_index` — порядковый номер в паке (0, 1, …).

**В Storage (bucket `stickers`):**
- **Одиночный:** путь вида `stickers/{user_id}/{session_id}/{timestamp}.webp` — третий сегмент это `sessions.id`.
- **Пак:** путь вида `stickers/{user_id}/{pack_batch_id}/{timestamp}_0.webp`, `..._1.webp` и т.д. — третий сегмент это `pack_batches.id`.

По одному пути в Storage тип не виден (оба UUID). Надёжно различать только по БД: смотреть `stickers.pack_batch_id` или проверять, есть ли UUID из пути в `pack_batches.id` (пак) или только в `sessions.id` (одиночный).

**Примеры SQL:**

```sql
-- Только одиночные стикеры
SELECT id, user_id, session_id, result_storage_path, style_preset_id
FROM stickers
WHERE pack_batch_id IS NULL AND result_storage_path IS NOT NULL;

-- Только стикеры из паков
SELECT id, user_id, pack_batch_id, pack_index, result_storage_path
FROM stickers
WHERE pack_batch_id IS NOT NULL AND result_storage_path IS NOT NULL;
```

### Поток данных

1. **Single/assistant flow**  
   Воркер после генерации: заливает файл в Storage → пишет строку в **stickers** (result_storage_path, потом telegram_file_id) → обновляет **sessions** (last_sticker_file_id, last_sticker_storage_path).  
   Итог: один стикер представлен и в `stickers`, и в `sessions` (только «последний» в сессии).

2. **Pack flow**  
   Превью: лист хранится в `sessions.pack_sheet_file_id` (Telegram); при rembg — ещё в `pack_batches.cleaned_sheet_storage_path`.  
   После сборки пака: каждый стикер пака пишется в **stickers** (pack_batch_id, pack_index, result_storage_path); в **sessions** «последний стикер» не обновляется под паки (там остаётся последний single-стикер, если был).

3. **Исторические/старые сессии**  
   Раньше код мог не писать в `stickers`, но всегда обновлял `sessions.last_sticker_file_id`. Поэтому для бэкапа в Storage источник правды по «последнему стикеру» — **sessions**, а не только stickers.

## Проблемы текущей схемы

- **Дублирование**: один и тот же «последний» стикер описан и в `stickers`, и в `sessions` (last_sticker_*). Для старых сессий в `stickers` может не быть строки.
- **Бэкап по stickers** находит 0 записей, если все стикеры либо уже с result_storage_path, либо строки в stickers не создавались (только sessions).
- **Превью пака**: file_id только в sessions; долгосрочное хранение — в pack_batches.cleaned_sheet_storage_path (не у всех батчей заполнено).

## Варианты оптимизации

### 1. Один источник правды для «файл → Storage»

- **Стикеры**: источник правды — таблица **stickers**. Каждая генерация (single/pack) всегда создаёт строку в stickers с result_storage_path и telegram_file_id. В sessions храним только last_sticker_file_id (и при необходимости last_sticker_storage_path) как кэш для текущего flow, без использования для бэкапа/аналитики.
- **Бэкап**: делать и по **stickers** (все без result_storage_path), и по **sessions** (last_sticker_file_id есть, last_sticker_storage_path нет → качать, заливать, обновлять last_sticker_storage_path; при желании создавать/обновлять запись в stickers по session_id + last_sticker_file_id).

### 2. Бэкап из sessions (приоритет для старых данных)

- Выборка: `sessions` где `last_sticker_file_id IS NOT NULL` и `last_sticker_storage_path IS NULL`, по нужному `env`.
- Для каждой: скачать по last_sticker_file_id из Telegram → залить в Storage (например `stickers/{user_id}/backfill_session/{session_id}.webp`) → обновить `sessions.last_sticker_storage_path`.
- Опционально: для каждой такой сессии создавать или обновлять запись в `stickers` (по session_id + каким-то признакам «последний стикер»), чтобы дальше аналитика и бэкап шли уже из stickers.

### 3. Пакеты: лист превью в Storage

- Для `sessions.pack_sheet_file_id` без соответствующего `pack_batches.cleaned_sheet_storage_path`: скрипт бэкапа может качать лист из Telegram, заливать в Storage (например `pack_sheets/{pack_batch_id}.png`), обновлять `pack_batches.cleaned_sheet_storage_path`. Тогда assemble и превью смогут опираться на Storage, а не только на Telegram.

### 4. Долгосрочно: меньше дублирования в sessions

- В sessions оставить только то, что нужно для текущего flow: last_sticker_file_id (и при необходимости last_sticker_storage_path для быстрого доступа). Всё остальное «какой стикер куда залит» — только в stickers. Тогда бэкап и отчёты — только по stickers; sessions — только runtime-кэш.

## Рекомендации

1. **Сейчас**: добавить в скрипт бэкапа режим **из sessions**: выборка по last_sticker_file_id + отсутствию last_sticker_storage_path, заливка в Storage, обновление last_sticker_storage_path (и при необходимости синхронизация в stickers).
2. **Проверка в БД**: посчитать, сколько сессий с last_sticker_file_id и без last_sticker_storage_path; сколько стикеров без result_storage_path — чтобы понять объём бэкапа по каждому источнику.
3. **Дальше**: при любой новой генерации всегда писать в stickers; бэкап делать в первую очередь по stickers, по sessions — только для исторических данных и «последнего» стикера без записи в stickers.
