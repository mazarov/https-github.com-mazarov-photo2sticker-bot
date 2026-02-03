# Generation Progress — Требования

## Описание

Показывать пользователю детальный прогресс генерации стикера через редактирование одного сообщения. После завершения сообщение удаляется.

---

## Текущее поведение

1. Пользователь выбирает стиль
2. Бот отправляет: "✨ Принял! Генерирую стикер..."
3. Пользователь ждёт ~50 сек без обратной связи
4. Приходит стикер

---

## Новое поведение

7 шагов прогресса, равномерно распределённых по времени (~50 сек):

```
🔍 Анализирую фото... (1/7)
↓ ~3 сек
🎨 Подбираю стиль... (2/7)
↓ ~5 сек
✨ Генерирую изображение... (3/7)
↓ ~20 сек (Gemini)
🖼 Обрабатываю результат... (4/7)
↓ ~3 сек
✂️ Удаляю фон... (5/7)
↓ ~10 сек (Pixian)
📐 Оптимизирую размер... (6/7)
↓ ~3 сек
📦 Подготавливаю стикер... (7/7)
↓ ~3 сек
[Сообщение удаляется]
↓
[Стикер с кнопками]
```

---

## Этапы и тексты

| Шаг | Ключ | RU | EN | Когда показывать |
|-----|------|----|----|------------------|
| 1 | `progress.step1` | 🔍 Анализирую фото... (1/7) | 🔍 Analyzing photo... (1/7) | Сразу при старте |
| 2 | `progress.step2` | 🎨 Подбираю стиль... (2/7) | 🎨 Selecting style... (2/7) | Перед загрузкой фото |
| 3 | `progress.step3` | ✨ Генерирую изображение... (3/7) | ✨ Generating image... (3/7) | Перед Gemini API |
| 4 | `progress.step4` | 🖼 Обрабатываю результат... (4/7) | 🖼 Processing result... (4/7) | После Gemini API |
| 5 | `progress.step5` | ✂️ Удаляю фон... (5/7) | ✂️ Removing background... (5/7) | Перед Pixian API |
| 6 | `progress.step6` | 📐 Оптимизирую размер... (6/7) | 📐 Optimizing size... (6/7) | После Pixian API |
| 7 | `progress.step7` | 📦 Подготавливаю стикер... (7/7) | 📦 Preparing sticker... (7/7) | Перед отправкой |

---

## Технические изменения

### 1. Поля в `sessions` (уже есть)

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS progress_message_id bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS progress_chat_id bigint;
```

### 2. API (index.ts) — при старте генерации

```typescript
// Отправляем начальное сообщение (шаг 1)
const progressMsg = await ctx.reply(await getText(lang, "progress.step1"));

// Сохраняем message_id и chat_id в сессию
await supabase
  .from("sessions")
  .update({ 
    progress_message_id: progressMsg.message_id,
    progress_chat_id: ctx.chat.id 
  })
  .eq("id", session.id);
```

### 3. Worker (worker.ts) — функции прогресса

```typescript
async function updateProgress(session: any, lang: string, step: 1 | 2 | 3 | 4 | 5 | 6 | 7) {
  if (!session.progress_message_id || !session.progress_chat_id) return;
  
  try {
    await editMessageText(
      session.progress_chat_id, 
      session.progress_message_id, 
      await getText(lang, `progress.step${step}`)
    );
  } catch (err) {
    // ignore edit errors
  }
}

async function clearProgress(session: any) {
  if (!session.progress_message_id || !session.progress_chat_id) return;
  
  try {
    await deleteMessage(session.progress_chat_id, session.progress_message_id);
  } catch (err) {
    // ignore delete errors
  }
}
```

### 4. Worker — вызов на каждом этапе

```typescript
async function runJob(job: any) {
  // ... получение session, user, lang ...

  // Шаг 2: Подбираю стиль
  await updateProgress(session, lang, 2);
  
  const filePath = await getFilePath(sourceFileId);
  const fileBuffer = await downloadFile(filePath);
  const base64 = fileBuffer.toString("base64");

  // Шаг 3: Генерирую изображение
  await updateProgress(session, lang, 3);
  
  const geminiRes = await axios.post(/* Gemini API */);
  
  // Шаг 4: Обрабатываю результат
  await updateProgress(session, lang, 4);
  
  const generatedBuffer = Buffer.from(imageBase64, "base64");

  // Шаг 5: Удаляю фон
  await updateProgress(session, lang, 5);
  
  const pixianRes = await axios.post(/* Pixian API */);
  
  // Шаг 6: Оптимизирую размер
  await updateProgress(session, lang, 6);
  
  const stickerBuffer = await sharp(noBgBuffer)
    .trim()
    .resize(512, 512, { fit: "contain", background: transparent })
    .webp()
    .toBuffer();

  // Шаг 7: Подготавливаю стикер
  await updateProgress(session, lang, 7);
  
  // Upload to storage
  await supabase.storage.from(bucket).upload(path, stickerBuffer);
  
  // Save to history
  await supabase.from("stickers").insert({ ... });
  
  // Send sticker
  const stickerFileId = await sendSticker(telegramId, stickerBuffer, replyMarkup);
  
  // Clear progress message
  await clearProgress(session);
  
  // Update session
  await supabase.from("sessions").update({ ... }).eq("id", session.id);
}
```

---

## SQL миграция

```sql
-- Progress texts (7 steps)
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'progress.step1', '🔍 Анализирую фото... (1/7)'),
  ('en', 'progress.step1', '🔍 Analyzing photo... (1/7)'),
  ('ru', 'progress.step2', '🎨 Подбираю стиль... (2/7)'),
  ('en', 'progress.step2', '🎨 Selecting style... (2/7)'),
  ('ru', 'progress.step3', '✨ Генерирую изображение... (3/7)'),
  ('en', 'progress.step3', '✨ Generating image... (3/7)'),
  ('ru', 'progress.step4', '🖼 Обрабатываю результат... (4/7)'),
  ('en', 'progress.step4', '🖼 Processing result... (4/7)'),
  ('ru', 'progress.step5', '✂️ Удаляю фон... (5/7)'),
  ('en', 'progress.step5', '✂️ Removing background... (5/7)'),
  ('ru', 'progress.step6', '📐 Оптимизирую размер... (6/7)'),
  ('en', 'progress.step6', '📐 Optimizing size... (6/7)'),
  ('ru', 'progress.step7', '📦 Подготавливаю стикер... (7/7)'),
  ('en', 'progress.step7', '📦 Preparing sticker... (7/7)')
ON CONFLICT (lang, key) DO UPDATE SET
  text = EXCLUDED.text,
  updated_at = now();

-- Удалить старые ключи (3 шага)
DELETE FROM bot_texts_new WHERE key IN (
  'progress.generating_image',
  'progress.removing_bg', 
  'progress.preparing'
);
```

---

## Fallback тексты (texts.ts)

```typescript
// RU
"progress.step1": "🔍 Анализирую фото... (1/7)",
"progress.step2": "🎨 Подбираю стиль... (2/7)",
"progress.step3": "✨ Генерирую изображение... (3/7)",
"progress.step4": "🖼 Обрабатываю результат... (4/7)",
"progress.step5": "✂️ Удаляю фон... (5/7)",
"progress.step6": "📐 Оптимизирую размер... (6/7)",
"progress.step7": "📦 Подготавливаю стикер... (7/7)",

// EN
"progress.step1": "🔍 Analyzing photo... (1/7)",
"progress.step2": "🎨 Selecting style... (2/7)",
"progress.step3": "✨ Generating image... (3/7)",
"progress.step4": "🖼 Processing result... (4/7)",
"progress.step5": "✂️ Removing background... (5/7)",
"progress.step6": "📐 Optimizing size... (6/7)",
"progress.step7": "📦 Preparing sticker... (7/7)",
```

---

## Распределение времени (~50 сек)

| Шаг | Операция | Время |
|-----|----------|-------|
| 1→2 | Старт, загрузка фото | ~3 сек |
| 2→3 | Подготовка данных | ~2 сек |
| 3→4 | Gemini API | ~20 сек |
| 4→5 | Обработка результата | ~2 сек |
| 5→6 | Pixian API | ~10 сек |
| 6→7 | Sharp resize | ~2 сек |
| 7→done | Upload + отправка | ~3 сек |
| **Итого** | | **~42-50 сек** |

---

## Чеклист

- [ ] Обновить fallback тексты в `texts.ts` (7 шагов)
- [ ] Обновить SQL миграцию `009_generation_progress.sql`
- [ ] API: отправлять `progress.step1` при старте
- [ ] Worker: вызывать `updateProgress` на каждом из 7 этапов
- [ ] Worker: удалить старые ключи (3 шага)
- [ ] Тестирование
