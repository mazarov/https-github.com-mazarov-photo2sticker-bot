# Video → Sticker Pack — Детальные требования

> Дата: 14.02.2026
> Статус: Проектирование
> Проект: photo2sticker-bot (основной бот @sticq_bot)

## 1. Концепция

Пользователь присылает видео (или ссылку на TikTok / YouTube Shorts) — бот анализирует сюжет, выбирает самые выразительные моменты, генерирует стикеры на основе реальных кадров и собирает готовый Telegram Sticker Pack.

**Цель**: вирусный промо-инструмент — пользователь делится паком в чатах, каждый пак = реклама бота.

## 2. User Flow

```
1. Пользователь отправляет:
   - Видео напрямую в бот (до 60 сек)
   - ИЛИ ссылку на TikTok / YouTube Shorts

2. Бот спрашивает стиль стикеров:
   - 🎨 Cartoon (мультяшный)
   - ✏️ Sketch (скетч)
   - 🌸 Kawaii (кавайный)
   - 🔥 Pixel Art
   - ✍️ Свой стиль (ввод текстом)

3. Бот отвечает:
   "🎬 Анализирую видео... (5 сек)"
   "🖼 Генерирую 8 стикеров... (20 сек)"
   "📦 Собираю пак... (3 сек)"

4. Результат:
   - Ссылка на готовый стикер-пак: t.me/addstickers/VideoStickers_12345_by_sticq_bot
   - Превью: 3-4 стикера показаны в чате
   - Кнопки: [📦 Открыть пак] [🔄 Другой стиль] [📷 Из фото]
```

## 3. Технический пайплайн

### 3.1. Получение видео

**Вариант A — Видео напрямую в бот (MVP)**:
- Telegram Bot API: `message.video` или `message.video_note`
- Лимит: до 20 MB (Telegram API), до 60 секунд
- Скачивание: `getFile` → `downloadFile` (уже реализовано в `telegram.ts`)

**Вариант B — Ссылка на TikTok / YouTube Shorts (фаза 2)**:
- Парсинг URL: regex для `tiktok.com`, `vm.tiktok.com`, `youtube.com/shorts/`
- Скачивание: `yt-dlp` (бинарник в Docker)
  ```bash
  yt-dlp -f "best[height<=720][ext=mp4]" --max-filesize 50M -o /tmp/video.mp4 "URL"
  ```
- Fallback: API-сервисы (RapidAPI TikTok Downloader) если yt-dlp блочат
- Ограничения: прокси для TikTok (серверные IP блочат)

### 3.2. Анализ видео — Gemini Video API

**Один вызов Gemini 2.5 Flash / Pro**:

```
Model: gemini-2.5-flash (быстрее) или gemini-2.5-pro (точнее)
Input: video/mp4 (до 20MB)

System Prompt:
  "You are a sticker pack designer. Analyze this short video and select 
   the 8 most expressive, emotionally distinct moments that would make 
   great stickers.
   
   For each moment, provide:
   - timestamp: float (seconds from start)
   - emotion: string (e.g. shocked, laughing, dancing, crying, angry)
   - pose_description: string (body language, hand positions, face)
   - sticker_text: string (1-3 words, meme-style caption)
   - importance: 1-10
   
   RULES:
   - Pick moments with DIFFERENT emotions (no duplicates)
   - Prefer clear face expressions and distinctive body language
   - Prefer well-lit frames where face is visible
   - Avoid blurry or transitional frames
   - Space moments at least 1.5 seconds apart
   
   Return as JSON array, sorted by timestamp."

Output:
{
  "character_description": "Young woman, brown hair in ponytail, round face, 
                            big brown eyes, wearing blue hoodie",
  "video_mood": "comedic, energetic",
  "moments": [
    {
      "timestamp": 2.8,
      "emotion": "shocked",
      "pose_description": "Mouth wide open, hands on cheeks, leaning back",
      "sticker_text": "OMG",
      "importance": 9
    },
    {
      "timestamp": 5.1,
      "emotion": "laughing",
      "pose_description": "Head tilted back, eyes closed, hand on stomach",
      "sticker_text": "LOL",
      "importance": 8
    },
    // ... ещё 6 моментов
  ]
}
```

**Оценка**: ~3-5 сек, ~$0.01-0.02

### 3.3. Извлечение ключевых кадров — FFmpeg

Для каждого таймкода из шага 3.2:

```bash
ffmpeg -ss {timestamp} -i video.mp4 -frames:v 1 -q:v 2 frame_{index}.jpg
```

На Node.js:
```typescript
import { exec } from "child_process";

async function extractFrame(videoPath: string, timestamp: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(
      `ffmpeg -ss ${timestamp} -i "${videoPath}" -frames:v 1 -q:v 2 "${outputPath}"`,
      (error) => error ? reject(error) : resolve()
    );
  });
}

// Извлечь все кадры параллельно (~100ms на кадр)
await Promise.all(moments.map((m, i) => 
  extractFrame(videoPath, m.timestamp, `/tmp/frame_${i}.jpg`)
));
```

**Зависимость**: `ffmpeg` в Docker (`apk add ffmpeg` в alpine).

### 3.4. Генерация стикеров — Gemini Image-to-Image

Для каждого кадра — отдельный вызов:

```
Model: gemini-2.5-flash-image / gemini-3-pro-image-preview
Input: frame_{index}.jpg (конкретный кадр)

Prompt:
  "Transform this photo into a sticker for a Telegram sticker pack.
   
   Character: {character_description}
   Style: {selected_style} (e.g. kawaii cartoon)
   Emotion: {emotion}
   Pose: {pose_description}
   
   CRITICAL RULES:
   - Keep EXACTLY the same pose, body position, and facial expression as in the photo
   - Keep the same person appearance (face shape, hair, clothing)
   - Style must be consistent: {selected_style} with bold outlines
   - Clean white/transparent background
   - Output: square format, character centered
   - Slightly exaggerate the expression for sticker effect
   - NO text on the sticker (text added separately)"

Output: PNG image
```

**Параллельная генерация**:
```typescript
const stickerBuffers = await Promise.all(
  moments.map((moment, i) => 
    generateSticker(frameBuffers[i], moment, characterDescription, selectedStyle)
  )
);
```

**Оценка**: 8 вызовов × ~10 сек = ~80 сек последовательно, **~15-20 сек параллельно**.
**Стоимость**: ~$0.02-0.05 за стикер × 8 = ~$0.15-0.40 за пак.

### 3.5. Пост-обработка — Sharp

Для каждого стикера:

```typescript
import sharp from "sharp";

async function processSticker(buffer: Buffer, text?: string): Promise<Buffer> {
  let img = sharp(buffer)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90 });
  
  // Опционально: добавить текст поверх (если sticker_text задан)
  if (text) {
    // SVG overlay с текстом
    const textSvg = buildTextOverlay(text, 512, 512);
    img = img.composite([{ input: Buffer.from(textSvg), blend: "over" }]);
  }
  
  return img.toBuffer();
}
```

### 3.6. Создание Telegram Sticker Pack

```typescript
// 1. Создать пак с первым стикером
await telegram.createNewStickerSet(
  userId,                                    // owner
  `video_${packId}_by_${botUsername}`,       // name
  `${userFirstName}'s Video Pack`,           // title
  [{ sticker: stickerBuffers[0], emoji_list: [emoji[0]] }],
  "static"                                   // sticker_type
);

// 2. Добавить остальные стикеры
for (let i = 1; i < stickerBuffers.length; i++) {
  await telegram.addStickerToSet(
    userId,
    `video_${packId}_by_${botUsername}`,
    { sticker: stickerBuffers[i], emoji_list: [emojis[i]] }
  );
}

// 3. Вернуть ссылку
const packUrl = `https://t.me/addstickers/video_${packId}_by_${botUsername}`;
```

## 4. Архитектура

### 4.1. Новые компоненты

```
src/
├── lib/
│   ├── video-download.ts     # Скачивание видео (Telegram / yt-dlp)
│   ├── video-analysis.ts     # Gemini Video API: анализ → JSON с таймкодами
│   ├── frame-extractor.ts    # FFmpeg: видео → jpg кадры по таймкодам
│   └── sticker-pack.ts       # Telegram API: createStickerSet + addStickerToSet
├── worker-video.ts           # Отдельный воркер для видео-пайплайна
```

### 4.2. Новые таблицы БД

```sql
-- Задания на генерацию видео-паков
CREATE TABLE video_pack_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid REFERENCES sessions(id),
  status text DEFAULT 'pending',          -- pending, analyzing, extracting, generating, packing, done, failed
  video_source text NOT NULL,             -- 'telegram' | 'tiktok' | 'youtube'
  video_file_id text,                     -- Telegram file_id (если видео)
  video_url text,                         -- URL (если ссылка)
  video_storage_path text,                -- путь в Supabase Storage
  selected_style text NOT NULL,           -- cartoon, sketch, kawaii, pixel, custom
  custom_style_text text,                 -- если selected_style = 'custom'
  -- Результат анализа
  character_description text,
  analysis_json jsonb,                    -- полный JSON от Gemini
  moments_count int DEFAULT 8,
  -- Результат генерации
  sticker_pack_name text,                 -- video_123_by_sticq_bot
  sticker_pack_url text,                  -- https://t.me/addstickers/...
  stickers_generated int DEFAULT 0,
  -- Мета
  credits_spent int DEFAULT 0,
  error_message text,
  env text DEFAULT 'prod',
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- Отдельные стикеры внутри пака
CREATE TABLE video_pack_stickers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_job_id uuid NOT NULL REFERENCES video_pack_jobs(id),
  moment_index int NOT NULL,              -- 0-7
  timestamp_sec float,
  emotion text,
  sticker_text text,
  frame_storage_path text,                -- путь к кадру в Storage
  sticker_storage_path text,              -- путь к стикеру в Storage
  telegram_file_id text,                  -- file_id стикера в Telegram
  generation_time_ms int,
  created_at timestamptz DEFAULT now()
);
```

### 4.3. Session State

Новые состояния для photo_session_state enum:

```sql
ALTER TYPE photo_session_state ADD VALUE 'wait_video';
ALTER TYPE photo_session_state ADD VALUE 'wait_video_style';
ALTER TYPE photo_session_state ADD VALUE 'processing_video';
```

### 4.4. Docker

```dockerfile
# Dockerfile.worker-video
FROM node:20-alpine

# FFmpeg для извлечения кадров
RUN apk add --no-cache ffmpeg

# yt-dlp для скачивания видео (фаза 2)
# RUN apk add --no-cache python3 && pip3 install yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

CMD ["node", "dist/worker-video.js"]
```

## 5. Стоимость и лимиты

### 5.1. Стоимость за один пак

| Операция | Стоимость |
|----------|-----------|
| Gemini Video Analysis | ~$0.02 |
| FFmpeg frame extraction | бесплатно |
| 8× Gemini Image Generation | ~$0.20-0.40 |
| Supabase Storage | ~$0.001 |
| **Итого** | **~$0.25-0.45** |

### 5.2. Кредиты

- Предлагаемая цена: **5 кредитов** за видео-пак (vs 1 кредит за обычный стикер)
- Обоснование: 8 стикеров + видео-анализ = 5× дороже

### 5.3. Лимиты

| Параметр | Лимит |
|----------|-------|
| Длительность видео | 60 сек max |
| Размер файла | 20 MB (Telegram) / 50 MB (yt-dlp) |
| Стикеров в паке | 8 (по умолчанию), опционально 6 или 12 |
| Паков на пользователя | без лимита (с кредитами) |
| Параллельных генераций | 4 (ограничение Gemini rate limit) |

## 6. Обработка ошибок

| Ситуация | Действие |
|----------|----------|
| Видео слишком длинное (>60с) | "Пришли видео до 60 секунд" |
| TikTok ссылка не скачивается | "Пришли видео напрямую в бот" |
| Gemini не нашёл лица в видео | "Не удалось найти персонажа — попробуй другое видео" |
| Генерация 1 стикера упала | Retry 2 раза, если не помогло — пак из 7 стикеров |
| Telegram: пак с таким именем существует | Добавить рандомный suffix |
| Gemini rate limit | Очередь, retry с backoff |

## 7. Фазы реализации

### Фаза 1 — MVP (5-6 дней)
- [ ] Принять видео напрямую в бот
- [ ] Gemini Video Analysis → JSON с таймкодами
- [ ] FFmpeg: извлечь кадры
- [ ] Gemini Image Generation: кадр → стикер (последовательно)
- [ ] Sharp: resize + WebP
- [ ] Telegram: createStickerSet
- [ ] Базовый UX: выбор стиля, progress, ссылка на пак

### Фаза 2 — Оптимизация (3-4 дня)
- [ ] Параллельная генерация стикеров (Promise.all)
- [ ] Текстовые overlay на стикерах
- [ ] Выбор количества стикеров (6/8/12)
- [ ] Красивый progress с превью каждого готового стикера

### Фаза 3 — Ссылки на видео (3-4 дня)
- [ ] Парсинг TikTok URL
- [ ] Парсинг YouTube Shorts URL
- [ ] yt-dlp в Docker
- [ ] Fallback на API-сервисы
- [ ] Прокси для TikTok

### Фаза 4 — Виральность (2-3 дня)
- [ ] Watermark "Made with @sticq_bot" на паке
- [ ] Кнопка "Поделиться паком"
- [ ] Реферальная ссылка: "Сделай свой пак → t.me/sticq_bot?start=videopack"
- [ ] Аналитика: сколько паков создано, сколько раз пак открыли

## 8. Метрики успеха

- **Конверсия**: % пользователей, которые создали пак после отправки видео
- **Виральность**: среднее число открытий пака другими людьми
- **Retention**: % пользователей, вернувшихся создать второй пак
- **Стоимость привлечения**: если пак открывают 10 человек → CAC = $0.04/человек
