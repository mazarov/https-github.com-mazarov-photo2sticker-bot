# Worker — `src/worker.ts`

Фоновый процесс, который обрабатывает задания на генерацию стикеров.
Работает отдельным Docker-контейнером, поллит очередь заданий из PostgreSQL.

## Принцип работы

```mermaid
sequenceDiagram
    participant API as API / Bot
    participant DB as PostgreSQL
    participant W as Worker
    participant G as Gemini API
    participant R as rembg
    participant TG as Telegram

    API->>DB: INSERT job (status: queued)
    loop Каждые 2 сек
        W->>DB: claim_job() — FOR UPDATE SKIP LOCKED
    end
    DB-->>W: Job claimed

    W->>DB: Fetch session + user
    W->>TG: Обновить progress-сообщение

    W->>TG: Download source photo
    W->>G: Generate image (Gemini)
    G-->>W: Generated image (PNG)

    W->>R: Remove background (rembg)
    R-->>W: Image without background

    W->>W: Trim + resize to 482px (+ 15px extend → 512px)
    W->>W: Convert to WebP

    W->>DB: Save sticker record
    W->>DB: Upload to Supabase Storage
    W->>TG: Send sticker + action buttons
    W->>DB: Update sticker with telegram_file_id
    W->>DB: Update session state → confirm_sticker
```

## Пайплайн генерации

### 1. Получение задания
- `claim_job(worker_id, env)` — RPC-функция с `FOR UPDATE SKIP LOCKED`
- Предотвращает двойную обработку при нескольких воркерах
- Worker ID: `photo2sticker-{env}-worker-{N}-{timestamp}`

### 2. Подготовка
- Загрузка сессии и пользователя из БД
- Определение типа генерации (`style`, `emotion`, `motion`, `text`)
- Обновление progress-сообщения: "⏳ Генерирую стикер..."

### 3. Скачивание исходного фото
- Источник: `session.current_photo_file_id` (Telegram file_id)
- Скачивание через Telegram Bot API → Buffer

### 4. Генерация изображения (Gemini)
- Модель: настраивается через `app_config` (по умолчанию: style → `gemini-3-pro-image-preview`, emotion/motion → `gemini-2.5-flash-image`)
- Входные данные: исходное фото + промпт
- Промпт содержит:
  - Инструкцию по стилю (из style preset или кастомный)
  - Требование фона: "flat uniform single color, highly contrasting"
  - Требования к композиции (не обрезать, оставить padding)
  - Требования к качеству (без водяных знаков, текста и т.д.)
- Retry с exponential backoff (3 попытки)

#### Subject/Object Lock (phase 1 -> v2 compatible)
- Worker читает профиль источника из `sessions.object_*` (если заполнен), иначе из `sessions.subject_*`.
- При включенном `subject_lock_enabled` или `object_lock_enabled` гарантирует наличие `Subject Lock Block` в prompt.
- Source определяется по типу генерации:
  - `style` -> source kind `photo`,
  - `emotion`/`motion`/`text` -> source kind `sticker`.
- Если включен `subject_profile_enabled` или `object_profile_enabled`/`object_profile_shadow_enabled` и profile для текущего source отсутствует, worker выполняет detector и сохраняет профиль в `sessions` (dual-write в `subject_*` + `object_*` при наличии колонок).
- Если `subject_postcheck_enabled=true`, worker валидирует число людей на результате и делает один retry с усиленным lock; при повторном mismatch задача завершается ошибкой (с рефандом через общий error-path).

### 5. Модерация контента
- Проверка на blocked content от Gemini
- Если заблокировано — уведомление пользователю + alert

### 6. Удаление фона

```mermaid
flowchart TD
    IMG[Сгенерированное изображение] --> RESIZE[Resize 1024x1024<br/>fit: inside, withoutEnlargement]
    RESIZE --> REMBG[rembg<br/>self-hosted, port 5000]
    REMBG --> CHECK{Успех?}
    CHECK -->|Да| PAD[Safety padding 5%<br/>прозрачная рамка]
    CHECK -->|Нет| PIXIAN[Pixian API<br/>fallback]
    PIXIAN --> PAD
    PAD --> RESULT[PNG с прозрачным фоном]
```

**rembg** (основной):
- Self-hosted сервис на `http://p2s-rembg:5000`
- Модель: isnet-general-use (ранее u2net — обновлено 2026-02-13)
- Вход: изображение ресайзится до 1024x1024 (fit: inside, withoutEnlargement) перед отправкой
- 2 попытки
- Health check перед каждым запросом

**Pixian** (fallback):
- Внешний API (pixian.ai)
- Используется если rembg недоступен или упал
- Авторизация через username/password

### 7. Финализация изображения
- Safety padding: после rembg добавляется 5% прозрачная рамка (`safetyPad = Math.round(Math.max(width, height) * 0.05)`)
- Trim пустого пространства (sharp)
- Resize до 482px (вписать, сохранить пропорции), затем extend +15px с каждой стороны → 512x512
- Конвертация в WebP (quality: 95%)

### 8. Сохранение и отправка
- INSERT в `stickers` таблицу
- Upload в Supabase Storage (`stickers` bucket)
- Отправка стикера через Telegram API
- Обновление `telegram_file_id` на записи стикера
- Обновление сессии: `state → confirm_sticker`

### 9. Пост-генерация
- **Онбординг** (первый стикер): специальное CTA-сообщение с идеями
- **Обычная генерация**: кнопки действий (стиль, эмоция, движение, текст, пак)
- Нотификация в алерт-канал (новый стикер)
- Инкремент `total_generations` у пользователя

## Pack flow в Worker (preview + assemble)

- `runPackPreviewJob`:
  - сцены: при `sessions.pack_content_set_id` берёт `pack_content_sets.scene_descriptions` (проверка: is_active, длина = template.sticker_count), иначе `pack_templates.scene_descriptions`
  - подстановка пола в сцены: плейсхолдер `{subject}` в описаниях заменяется на «man» или «woman» по **`getSubjectWordForPrompt(packSubjectProfile)`** (приоритет: `pack_subject_gender` → `subject_gender`/`object_gender` из детекции). См. [11-subject-profile-and-gender.md](11-subject-profile-and-gender.md)
  - добавляет выбранный пользователем `sessions.selected_style_id` (`style_presets_v2.prompt_hint`) в промпт
  - добавляет `Subject Lock Block` для текущего photo-source (если включен флаг)
  - добавляет `scene cardinality guard` по effective subject mode:
    - `single`: каждую сцену принудительно интерпретирует как solo-позу (без партнёра), даже если текст сцены содержит "couple/man and woman/both"
    - `multi`: требует сохранить ту же пару и запрещает добавлять третьих лиц
  - при `subject_mode_pack_filter_enabled=true` или `object_mode_pack_filter_enabled=true` делает финальную server-side проверку совместимости `pack_content_sets.subject_mode` и effective mode (`sessions.object_mode` -> fallback `sessions.subject_mode`) с рефандом preview-кредита при mismatch
  - включает блок `identity preservation` (сохранение facial identity)
  - генерирует лист NxN и сохраняет `pack_sheet_file_id`

- `runPackAssembleJob`:
  - скачивает `pack_sheet_file_id`, режет на ячейки
  - удаление фона для пака: **конфигурируемо через app_config**
    - ключ: `bg_removal_primary` (prod) / `bg_removal_primary_test` (test)
    - значения: `rembg` или `pixian`
    - fallback: если primary упал, используется второй провайдер
  - после BG removal: каждая ячейка пропускается через **`fitStickerIn512WithMargin(buffer, 0.05)`** — контент вписывается в 512×512 с отступом ~5% по краям (чтобы стикер не заполнял весь кадр; при вырезании фона отступы теряются)
  - подписи: при `sessions.pack_content_set_id` берёт `pack_content_sets.labels` / `labels_en`, иначе `pack_templates.labels` / `labels_en`; поверх накладывается через `addTextToSticker`
  - принудительная белая обводка в worker не добавляется (оставляем контур, который сгенерировал Gemini)
  - собирает Telegram sticker set (`createNewStickerSet` + `addStickerToSet`)

## Цепочка генерации (бизнес-логика)

```
Фото (AgAC) ──[style]──> Стикер (CAAC)
                               │
                     ┌─────────┼─────────┐
                     ▼         ▼         ▼
               [emotion]   [motion]   [text]
                     │         │         │
                     ▼         ▼         ▼
               Новый стикер (CAAC) ──> [emotion/motion] ──> ...
```

### Правила

- **Style** — ТОЛЬКО из оригинального фото пользователя (AgAC)
- **Emotion / Motion** — ТОЛЬКО из ранее созданного стикера (CAAC), НИКОГДА из фото
- **Text** — оверлей поверх стикера, генерация через Gemini не используется
- Цепочки произвольной длины: style → motion → emotion → motion → ...

### Типы генерации

| Тип | Источник (input) | `source_photo_file_id` в БД | Промпт |
|-----|-----------------|----------------------------|--------|
| `style` | Оригинальное фото (AgAC) | Оригинальное фото (AgAC) | style preset prompt_hint |
| `emotion` | Предыдущий стикер (CAAC) | Этот же стикер (CAAC) | emotion preset + стикер |
| `motion` | Предыдущий стикер (CAAC) | Этот же стикер (CAAC) | motion preset + стикер |
| `text` | Нет генерации | — | текстовый оверлей |

### Код определения источника

```typescript
// worker.ts — определение sourceFileId
const sourceFileId =
  generationType === "emotion" || generationType === "motion" || generationType === "text"
    ? session.last_sticker_file_id    // стикер (CAAC)
    : session.current_photo_file_id;  // оригинальное фото (AgAC)

// source_photo_file_id в БД = всегда sourceFileId
const savedSourcePhotoFileId = sourceFileId;
```

## Конфигурация

| Параметр | Default | Описание |
|----------|---------|----------|
| `JOB_POLL_INTERVAL_MS` | 2000 | Интервал опроса очереди |
| `APP_ENV` | prod | Окружение (фильтр заданий) |
| Gemini model | app_config: см. 04-database.md «Ключи моделей Gemini». Pack: `gemini_model_pack`, single: `gemini_model_style` / `gemini_model_emotion` / `gemini_model_motion` | Модель генерации |
| rembg URL | http://p2s-rembg:5000 | Адрес сервиса удаления фона |

## Обработка ошибок

- Retry генерации (3 попытки с backoff)
- Retry rembg (2 попытки)
- Fallback на Pixian при сбое rembg
- Alert в канал при критических ошибках
- Job помечается как `error` при исчерпании попыток
- Сообщение пользователю об ошибке
