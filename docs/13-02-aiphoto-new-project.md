# AI Photo Bot — новый проект

**Дата:** 13.02.2026  
**Статус:** Планирование

## Суть

Telegram бот для ИИ-генерации фото. Пользователь отправляет фото + выбирает параметры → получает сгенерированное фото.

**Отличие от photo2sticker:**
- Результат — фото (не стикер)
- Нет удаления фона (rembg, chromaKey, Pixian)
- Выбор модели, формата, качества

## Параметры проекта

| Параметр | Значение |
|---|---|
| Тестовый бот | `@sticq_bot` |
| Репо | `github.com/mazarov/aiphoto` (приватный) |
| Supabase | та же инстанция, отдельные таблицы с префиксом `photo_` |
| Dockhost | 3 контейнера (api, worker, support) |
| Основа | Fork кода photo2sticker-bot |
| Workspace | Submodule `aiphoto/` в текущем workspace |

## User Flow

```
Фото → Выбор стиля → Выбор модели (2.5/3.0) → Выбор формата → Выбор качества → Генерация → Фото
```

### Шаги:
1. Пользователь отправляет фото
2. Выбор стиля (кнопки — пресеты, аналог текущих стилей)
3. Выбор модели: `gemini-2.5-flash-image` / `gemini-3-pro-image-preview`
4. Выбор формата (aspect ratio): 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3
5. Выбор качества: FullHD (1920px) / 2K (2560px) / 4K (3840px)
6. Генерация через Gemini
7. Resize по формату + качеству
8. Отправка результата как фото (sendPhoto, не sendSticker)

## Архитектура

### Контейнеры (Dockhost)

| Контейнер | Dockerfile | Описание |
|---|---|---|
| api | `Dockerfile.api` | Telegram бот (webhook / long polling) |
| worker | `Dockerfile.worker` | Воркер генерации фото |
| support | `Dockerfile.support` | Саппорт бот |

**Нет rembg контейнера** — удаление фона не нужно.

### Supabase — отдельные таблицы

Префикс `photo_` для всех таблиц:

| Таблица | Описание |
|---|---|
| `photo_users` | Пользователи |
| `photo_sessions` | Сессии |
| `photo_jobs` | Очередь заданий |
| `photo_stickers` (→ `photo_results`) | Результаты генерации |
| `photo_transactions` | Транзакции/оплаты |
| `photo_sticker_sets` (→ убрать) | Не нужно |
| `photo_sticker_ratings` (→ `photo_ratings`) | Рейтинги |
| `photo_app_config` | Настройки (модели и т.д.) |
| `photo_prompt_templates` | Шаблоны промптов |

### Env-переменные (отдельные)

```
TELEGRAM_BOT_TOKEN=<токен @sticq_bot>
ALERT_CHANNEL_ID=<отдельный канал алертов>
SUPPORT_BOT_TOKEN=<отдельный саппорт бот>
SUPABASE_*=<та же инстанция>
GEMINI_API_KEY=<тот же ключ>
```

## Что убрать из fork

- `rembg_server.py`, `Dockerfile.rembg.build`, `Dockerfile.rembg`
- `src/lib/image-utils.ts` — chromaKey, fullChromaKey, getGreenPixelRatio
- В `worker.ts` — весь пайплайн удаления фона (rembg, pixian, chromaKey, smart routing)
- Sticker-специфика: `sendSticker`, стикерпаки, 512x512 resize, WebP конвертация
- Ссылки на `sticker_sets`, `sticker_set_name`
- `REMBG_URL`, `PIXIAN_USERNAME`, `PIXIAN_PASSWORD` из config

## Что добавить

### Новые кнопки в боте
- Выбор модели: `model_flash` / `model_pro`
- Выбор формата: `format_1_1`, `format_4_3`, `format_3_4`, `format_16_9`, `format_9_16`, `format_3_2`, `format_2_3`
- Выбор качества: `quality_fhd`, `quality_2k`, `quality_4k`

### Новые колонки в сессии
- `selected_model` — выбранная модель
- `selected_aspect_ratio` — формат
- `selected_quality` — качество

### Worker — упрощённый пайплайн
```
Gemini API → resize (формат + качество) → PNG/JPEG → sendPhoto
```

### Размеры по качеству × формату
| Качество | Макс. сторона |
|---|---|
| FullHD | 1920px |
| 2K | 2560px |
| 4K | 3840px |

Формат (aspect ratio) определяет пропорции: width × height рассчитываются от макс. стороны.

## Что адаптировать

- `index.ts` — новый flow кнопок, убрать sticker-специфику
- `worker.ts` — убрать bg removal, добавить resize по формату/качеству, sendPhoto вместо sendSticker
- `config.ts` — убрать rembg/pixian, добавить дефолты моделей
- `texts.ts` — новые тексты для кнопок и сообщений
- SQL миграции — все таблицы с префиксом `photo_`
- `claim_job` RPC — новая версия для `photo_jobs`

## Порядок реализации

1. [ ] Создать репо `mazarov/aiphoto` на GitHub (приватный)
2. [ ] Push текущего кода в новый репо
3. [ ] Добавить как submodule: `git submodule add git@github.com:mazarov/aiphoto.git aiphoto`
4. [ ] Вычистить rembg, sticker-специфику
5. [ ] Создать SQL миграции с `photo_` таблицами
6. [ ] Адаптировать flow: стиль → модель → формат → качество
7. [ ] Адаптировать worker: Gemini → resize → sendPhoto
8. [ ] Настроить env для `@sticq_bot`
9. [ ] Поднять контейнеры на Dockhost
10. [ ] Тестировать
