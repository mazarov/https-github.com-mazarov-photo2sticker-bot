# Face Swap в анимированных стикерах (Facemint API)

## Контекст

Пользователь хочет вставить своё лицо в анимированный стикер (gift sticker). Gemini не подходит — safety filters блокируют замену лиц. Нужна специализированная модель.

**Выбранное решение:** Facemint.io — cloud API для face swap в фото, GIF и видео.

---

## Пользовательский флоу

```
1. Пользователь присылает анимированный стикер (is_video=true / is_animated=true)
2. Бот: "Отправь своё фото, и я вставлю твоё лицо в этот стикер"
3. Пользователь присылает фото
4. Бот: "⏳ Обрабатываю..." (progress message)
5. Worker: конвертирует стикер → GIF/MP4, отправляет в Facemint API
6. Facemint: замена лица на всех кадрах
7. Worker: конвертирует результат → WebM (video sticker формат Telegram)
8. Бот: отправляет video sticker пользователю
```

```mermaid
sequenceDiagram
    participant U as Пользователь
    participant BOT as Bot (index.ts)
    participant DB as PostgreSQL
    participant W as Worker
    participant S as Supabase Storage
    participant FM as Facemint API
    participant TG as Telegram

    U->>BOT: Анимированный стикер
    BOT->>DB: session.state = wait_gift_photo
    BOT->>DB: Сохранить sticker file_id
    BOT->>U: "Отправь своё фото"

    U->>BOT: Фото
    BOT->>DB: session.current_photo_file_id = фото
    BOT->>DB: INSERT job (type: gift_face_swap)
    BOT->>U: "⏳ Обрабатываю..."

    W->>DB: claim_job()
    W->>TG: Скачать стикер (WebM)
    W->>TG: Скачать фото пользователя
    W->>S: Upload стикер + фото → получить public URLs
    W->>FM: POST /create-face-swap-task (GIF + face photo)
    
    loop Poll каждые 2 сек
        W->>FM: POST /get-task-info
    end
    FM-->>W: Результат (GIF/MP4 URL)
    
    W->>W: Скачать результат
    W->>W: Конвертировать → WebM (video sticker)
    W->>DB: INSERT sticker (generation_type: gift_face_swap)
    W->>TG: Отправить video sticker
    W->>DB: session.state = confirm_sticker
```

---

## Facemint API

### Base URL

```
https://api.facemint.io/api
```

### Авторизация

Header: `x-api-key: <FACEMINT_API_KEY>`

### Создание задачи

```
POST /api/create-face-swap-task
```

```json
{
  "type": "gif",
  "media_url": "https://storage.example.com/sticker.gif",
  "resolution": 1,
  "enhance": 1,
  "nsfw_check": 0,
  "face_recognition": 0.8,
  "face_detection": 0.25,
  "watermark": "",
  "callback_url": "",
  "swap_list": [
    {
      "from_face": "",
      "to_face": "https://storage.example.com/user-photo.png"
    }
  ],
  "start_time": 0,
  "end_time": 0
}
```

**Важно:**
- `from_face` пустой → заменяются ВСЕ лица в стикере на `to_face`
- `type: "gif"` — для анимированных стикеров (конвертируем WebM → GIF перед отправкой)
- `resolution: 1` (480p) — достаточно для стикеров 512×512
- `enhance: 1` — улучшение качества лица
- `watermark: ""` — без водяного знака (на платном плане)

### Ответ

```json
{
  "code": 0,
  "info": "ok",
  "data": {
    "taskId": "683b82962ea80a690d299a7c",
    "price": 2000
  }
}
```

### Получение результата

```
POST /api/get-task-info
```

```json
{ "task_id": "683b82962ea80a690d299a7c" }
```

**Статусы:** `-1` (failed), `0` (pending), `1` (processing), `2` (cancelled), `3` (success)

**Результат при `state: 3`:**

```json
{
  "data": {
    "state": 3,
    "result": {
      "file_url": "https://cdn.facemint.io/result.gif",
      "thumb_url": "https://cdn.facemint.io/thumb.jpg"
    }
  }
}
```

### Альтернатива: callback

Вместо polling можно передать `callback_url` — Facemint отправит POST с результатом. Но для MVP проще polling в worker.

---

## Ценообразование

| Тип | Цена | Наш кейс |
|-----|------|----------|
| GIF | $0.002 / 100KB | Стикер ~50-200KB → **$0.001-0.004** |
| Видео | $0.0045/сек × множители | 3 сек стикер, 480p, 1 лицо, enhance: $0.0045 × 3 × 1 × 0.8 × 2 = **$0.022** |

**Оптимальный вариант:** конвертировать стикер в GIF и отправлять как `type: "gif"`. Цена: **~$0.002-0.004 за стикер**. Это дешевле одного вызова Gemini.

---

## Форматы стикеров в Telegram

| Тип | Формат файла | `is_animated` | `is_video` | Как обрабатывать |
|-----|-------------|---------------|------------|------------------|
| Статичный | WebP | false | false | Уже поддерживается (edit sticker flow) |
| Animated (Lottie) | TGS (gzip Lottie JSON) | true | false | TGS → GIF (lottie-renderer) → Facemint |
| Video | WebM (VP9) | false | true | WebM → GIF (ffmpeg) → Facemint |

### Конвертация

**WebM → GIF (ffmpeg):**
```bash
ffmpeg -i sticker.webm -vf "fps=15,scale=512:-1" -loop 0 sticker.gif
```

**TGS → GIF:**
- Библиотека: `lottie-node` / `puppeteer` + `lottie-web` / `rlottie`
- Или: `tgs-to-gif` npm пакет
- Сложнее, чем WebM — требует рендеринг Lottie-анимации в кадры

**Результат GIF → WebM (для отправки как video sticker):**
```bash
ffmpeg -i result.gif -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 400k \
  -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=0x00000000" \
  -an -t 3 result.webm
```

### Требования Telegram к video stickers

- Формат: WebM (VP9 codec, alpha channel)
- Размер: одна сторона ровно 512px, вторая ≤ 512px
- Длительность: ≤ 3 секунды
- Без аудио
- Макс. размер файла: 256KB

---

## Изменения в БД

### Миграция `sql/124_gift_face_swap.sql`

```sql
-- Новые состояния сессии для gift sticker flow
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_gift_sticker';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_gift_photo';

-- Поле для хранения file_id анимированного стикера
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS gift_sticker_file_id text;

COMMENT ON COLUMN sessions.gift_sticker_file_id
  IS 'Telegram file_id of animated/video sticker for gift face swap flow';

-- Новый тип генерации (stickers.generation_type уже text, просто документируем)
-- generation_type: 'gift_face_swap'
```

---

## Изменения в коде

### 1. Config (`src/config.ts`)

```typescript
facemintApiKey: process.env.FACEMINT_API_KEY || "",
facemintBaseUrl: "https://api.facemint.io/api",
```

### 2. Facemint client (`src/lib/facemint.ts`)

```typescript
interface FacemintCreateTaskParams {
  type: "gif" | "video" | "image";
  media_url: string;
  swap_list: Array<{ from_face: string; to_face: string }>;
  resolution?: number;    // 1=480p (default for stickers)
  enhance?: number;       // 1=on (default)
  watermark?: string;     // "" = no watermark
  callback_url?: string;
  start_time?: number;
  end_time?: number;
  nsfw_check?: number;
  face_recognition?: number;
  face_detection?: number;
}

interface FacemintTaskResult {
  id: string;
  state: -1 | 0 | 1 | 2 | 3;  // -1=failed, 0=pending, 1=processing, 2=cancelled, 3=success
  price: number;
  process: number;  // 0-100%
  result: {
    file_url: string;
    thumb_url: string;
  };
}

async function createFaceSwapTask(params: FacemintCreateTaskParams): Promise<string>;  // taskId
async function getTaskInfo(taskId: string): Promise<FacemintTaskResult>;
async function waitForTask(taskId: string, timeoutMs?: number): Promise<FacemintTaskResult>;  // polling
```

### 3. Sticker handler (`src/index.ts`)

Текущий код отклоняет animated/video стикеры. Изменения:

```typescript
// Было:
if (sticker?.is_animated || sticker?.is_video) {
  await ctx.reply("Only static stickers...");
  return;
}

// Стало:
if (sticker?.is_animated || sticker?.is_video) {
  // Gift face swap flow
  await updateSession(sessionId, {
    state: "wait_gift_photo",
    gift_sticker_file_id: sticker.file_id,
  });
  await ctx.reply(t("gift.send_photo", lang));
  return;
}
```

### 4. Photo handler — ветка `wait_gift_photo`

```typescript
if (session.state === "wait_gift_photo") {
  const photoFileId = ctx.message.photo?.at(-1)?.file_id;
  await updateSession(sessionId, {
    current_photo_file_id: photoFileId,
  });
  // Списать кредит
  // Создать job
  await startGeneration(sessionId, userId, "gift_face_swap");
  return;
}
```

### 5. Worker — ветка `gift_face_swap`

```typescript
if (generationType === "gift_face_swap") {
  // 1. Скачать анимированный стикер (WebM/TGS)
  const stickerBuffer = await downloadTelegramFile(session.gift_sticker_file_id);
  
  // 2. Конвертировать в GIF (ffmpeg)
  const gifBuffer = await convertToGif(stickerBuffer, stickerFormat);
  
  // 3. Скачать фото пользователя
  const photoBuffer = await downloadTelegramFile(session.current_photo_file_id);
  
  // 4. Upload оба файла в Supabase Storage (нужны public URLs для Facemint)
  const gifUrl = await uploadToStorage(gifBuffer, `gift/${jobId}/sticker.gif`);
  const photoUrl = await uploadToStorage(photoBuffer, `gift/${jobId}/face.png`);
  
  // 5. Создать задачу в Facemint
  const taskId = await facemint.createFaceSwapTask({
    type: "gif",
    media_url: gifUrl,
    swap_list: [{ from_face: "", to_face: photoUrl }],
    resolution: 1,  // 480p — достаточно для 512px стикера
    enhance: 1,
    watermark: "",
    nsfw_check: 0,
    face_recognition: 0.8,
    face_detection: 0.25,
  });
  
  // 6. Ждать результат (polling)
  const result = await facemint.waitForTask(taskId, 60_000);
  
  // 7. Скачать результат
  const resultGifBuffer = await fetch(result.result.file_url).then(r => r.buffer());
  
  // 8. Конвертировать GIF → WebM (video sticker)
  const webmBuffer = await convertGifToWebm(resultGifBuffer);
  
  // 9. Отправить как video sticker
  await bot.telegram.sendSticker(chatId, { source: webmBuffer }, {
    // Telegram автоматически определит video sticker по WebM формату
  });
  
  // 10. Сохранить в БД
  // ...
}
```

---

## Утилиты конвертации

### `src/lib/convert-sticker.ts`

```typescript
import { execFile } from "child_process";

// WebM → GIF (для отправки в Facemint)
async function webmToGif(webmBuffer: Buffer): Promise<Buffer> {
  // ffmpeg -i input.webm -vf "fps=15,scale=512:-1" -loop 0 output.gif
}

// TGS → GIF (Lottie animated stickers)
async function tgsToGif(tgsBuffer: Buffer): Promise<Buffer> {
  // 1. gunzip TGS → Lottie JSON
  // 2. Render frames (lottie-node или puppeteer)
  // 3. Assemble GIF
}

// GIF → WebM (для отправки как video sticker в Telegram)
async function gifToWebm(gifBuffer: Buffer): Promise<Buffer> {
  // ffmpeg -i input.gif -c:v libvpx-vp9 -pix_fmt yuva420p
  //   -b:v 400k -vf "scale=512:512:..." -an -t 3 output.webm
}
```

**Зависимости:**
- `ffmpeg` — нужен в Docker-образе worker'а
- Для TGS: `pako` (gunzip) + рендерер Lottie (опционально, Phase 2)

---

## Тексты

| Ключ | RU | EN |
|------|----|----|
| `gift.send_photo` | Отправь своё фото, и я вставлю твоё лицо в этот стикер 🎭 | Send your photo and I'll put your face in this sticker 🎭 |
| `gift.processing` | ⏳ Вставляю твоё лицо в стикер... | ⏳ Putting your face in the sticker... |
| `gift.done` | Готово! Вот твой стикер с твоим лицом 🎉 | Done! Here's the sticker with your face 🎉 |
| `gift.error` | Не удалось обработать стикер. Попробуй другой стикер или другое фото. | Couldn't process the sticker. Try another sticker or photo. |
| `gift.no_face` | Не нашёл лицо в стикере. Попробуй стикер, где лицо видно чётче. | Couldn't find a face in the sticker. Try one where the face is clearer. |

---

## Экономика

| Параметр | Значение |
|----------|----------|
| Себестоимость (Facemint GIF) | ~$0.002-0.004 |
| Себестоимость (Facemint Video) | ~$0.02 |
| Конвертация (ffmpeg, CPU) | ~$0.001 (negligible) |
| **Итого за стикер** | **~$0.003-0.02** |
| Цена для пользователя | 1 кредит (как обычный стикер) |
| Маржа | Сопоставима с Gemini-генерацией |

---

## Ограничения и риски

### Подтверждённые ограничения

1. **Facemint требует URL** — нельзя отправить файл напрямую. Нужно загрузить стикер и фото в Supabase Storage и передать public URL.
2. **Хранение результатов** — Facemint хранит файлы 7 дней, потом удаляет. Нужно скачать сразу.
3. **Водяной знак** — на бесплатном плане может быть watermark. Проверить на smoke test.
4. **TGS (Lottie)** — сложнее конвертировать в GIF, чем WebM. Можно отложить на Phase 2.
5. **Telegram video sticker limits** — макс 3 сек, 256KB, VP9 + alpha. Нужно убедиться, что конвертация укладывается.

### Требует проверки (smoke test)

1. **Качество face swap на cartoon стикерах** — Facemint заточен под реалистичные лица. Как работает на cartoon?
2. **`from_face: ""`** — действительно ли заменяет все лица? Или нужно сначала detect faces?
3. **Скорость обработки** — сколько секунд от создания задачи до результата?
4. **Минимальный размер лица** — на маленьких стикерах лицо может быть слишком мелким для детекции.
5. **Alpha channel** — сохраняется ли прозрачность при обработке GIF?

### Митигация рисков

| Риск | Митигация |
|------|-----------|
| Facemint не находит лицо | Сообщение пользователю "Не нашёл лицо, попробуй другой стикер" |
| Плохое качество на cartoon | Fallback: предложить статичный replace_subject через Gemini (один кадр) |
| Facemint API недоступен | Retry 3 раза с backoff. Alert в admin-канал. |
| Результат > 256KB (лимит Telegram) | Пережать WebM с меньшим bitrate |
| Прозрачность теряется | Добавить rembg-шаг после Facemint (как для обычных стикеров) |

---

## Порядок реализации

### Phase 0: Smoke test (до кода)

- [ ] Зарегистрироваться на facemint.io, получить API key
- [ ] Вручную скачать анимированный стикер из Telegram (WebM)
- [ ] Конвертировать в GIF (ffmpeg)
- [ ] Загрузить GIF + фото на любой хостинг (public URL)
- [ ] Вызвать API через curl/Postman
- [ ] Оценить: качество, скорость, сохранение прозрачности
- [ ] Проверить на cartoon стикере и на реалистичном
- [ ] Задокументировать результаты в этом документе

### Phase 1: MVP (только video stickers, WebM)

- [ ] Миграция `sql/124_gift_face_swap.sql`
- [ ] Env: `FACEMINT_API_KEY`
- [ ] `src/lib/facemint.ts` — клиент API
- [ ] `src/lib/convert-sticker.ts` — WebM ↔ GIF конвертация (ffmpeg)
- [ ] `ffmpeg` в Docker-образ worker'а
- [ ] Sticker handler: принять video sticker → `wait_gift_photo`
- [ ] Photo handler: ветка `wait_gift_photo` → создать job
- [ ] Worker: ветка `gift_face_swap` — полный пайплайн
- [ ] Тексты
- [ ] Тест на test-боте

### Phase 2: Animated stickers (TGS/Lottie)

- [ ] TGS → GIF конвертация (lottie renderer)
- [ ] Поддержка `is_animated=true` стикеров
- [ ] Тесты

### Phase 3: Улучшения

- [ ] Callback вместо polling (отдельный webhook endpoint)
- [ ] Кеширование: если тот же стикер + то же фото → отдать из кеша
- [ ] Выбор конкретного лица (если в стикере несколько лиц)
- [ ] Кнопка "Попробовать другое фото" после результата

### Phase 4: Документация

- [ ] `docs/architecture/02-worker.md` — добавить gift_face_swap pipeline
- [ ] `docs/architecture/01-api-bot.md` — добавить gift sticker states
- [ ] `docs/architecture/04-database.md` — новые колонки/состояния

---

## Решения, требующие обсуждения

1. **GIF vs Video для Facemint?**
   - GIF дешевле ($0.002/100KB), но теряет alpha channel
   - Video дороже ($0.0045/сек), но может сохранить качество лучше
   - Решение: smoke test покажет

2. **Прозрачность фона**
   - Анимированные стикеры имеют прозрачный фон
   - GIF поддерживает только 1-bit transparency (есть/нет)
   - Может понадобиться: Facemint → GIF → rembg на каждый кадр → WebM
   - Или: отправлять как video (MP4) → Facemint → rembg → WebM

3. **Стоимость для пользователя**
   - 1 кредит (как обычный стикер) — если себестоимость ~$0.003-0.02
   - 2 кредита — если себестоимость выше из-за rembg на каждый кадр

4. **Отдельный flow или расширение edit sticker?**
   - Сейчас: edit sticker flow отклоняет animated/video
   - Вариант A: отдельный gift flow (wait_gift_sticker → wait_gift_photo)
   - Вариант B: расширить edit sticker (убрать reject, добавить face swap как опцию)
   - Рекомендация: вариант A (отдельный flow), чтобы не ломать существующий edit
