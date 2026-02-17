# Добавление текста на стикер

## Цель

Позволить пользователю добавить текст на существующий стикер. Gemini органично встраивает текст в изображение, сохраняя стиль и персонажа.

## UI Flow

```
[Стикер]
[➕ Добавить в пак] [🎨 Изменить стиль]
[😊 Изменить эмоцию] [🏃 Изменить движение]
[✏️ Добавить текст]  ← новая кнопка
```

## Сценарий использования

1. Пользователь нажимает **"✏️ Добавить текст"**
2. Бот отвечает: *"Введите текст для стикера:"*
3. Пользователь вводит текст (например: `Привет!`)
4. Бот генерирует новый стикер с текстом — **1 кредит**
5. Стикер отправляется с теми же кнопками действий

## Промпт для Gemini

```
Add the following text EXACTLY as written to the sticker: "{text}"

IMPORTANT: 
- Do NOT translate the text
- Do NOT change the text in any way
- Use the EXACT characters provided by the user

The text should be integrated naturally and visually appealing - it can appear on a sign, 
banner, speech bubble, or creatively placed within the image. 
Keep the same character, style, and colors.
```

**Критически важно:**
- Текст НЕ переводится
- Текст НЕ изменяется
- Используются ТОЧНО те символы, что ввёл пользователь

**Пример:**
- Пользователь ввёл: `Привет!`
- На стикере должно быть: `Привет!` (не "Hello!", не "Privet!")

## База данных

### Изменения в sessions

```sql
-- Новые состояния для session_state enum
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_text';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'processing_text';

-- Новое поле для хранения текста
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS text_prompt text;
```

### Поля сессии

| Поле | Тип | Описание |
|------|-----|----------|
| state | session_state | `wait_text` — ожидание ввода текста |
| state | session_state | `processing_text` — генерация с текстом |
| text_prompt | text | Введённый пользователем текст |

## Локализация

### Тексты

| Ключ | RU | EN |
|------|----|----|
| `btn.add_text` | ✏️ Добавить текст | ✏️ Add text |
| `text.prompt` | Введите текст для стикера: | Enter text for the sticker: |

### SQL миграция

```sql
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'btn.add_text', '✏️ Добавить текст'),
  ('en', 'btn.add_text', '✏️ Add text'),
  ('ru', 'text.prompt', 'Введите текст для стикера:'),
  ('en', 'text.prompt', 'Enter text for the sticker:')
ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text;
```

## Реализация

### index.ts — Кнопка в replyMarkup

```typescript
// Добавить в массив кнопок после стикера
const addTextBtn = await getText(lang, "btn.add_text");
// ...
[
  { text: addTextBtn, callback_data: `add_text:${stickerId}` }
]
```

### index.ts — Callback handler

```typescript
// Callback: add text to sticker
bot.action(/^add_text:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];

  // Get sticker from DB
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker?.telegram_file_id || sticker.user_id !== user.id) {
    return;
  }

  // Get or create session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_text", is_active: true })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  // Update session
  await supabase
    .from("sessions")
    .update({
      state: "wait_text",
      is_active: true,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
    })
    .eq("id", session.id);

  await ctx.reply(await getText(lang, "text.prompt"));
});
```

### index.ts — Text handler

```typescript
// В обработчике текстовых сообщений
if (session.state === "wait_text") {
  const textInput = ctx.message.text.trim();
  if (!session.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  const promptFinal = buildTextPrompt(textInput);
  await startGeneration(ctx, user, session, lang, {
    generationType: "text",
    promptFinal,
    textPrompt: textInput,
  });
  return;
}
```

### index.ts — buildTextPrompt function

```typescript
function buildTextPrompt(text: string): string {
  return `Add the following text EXACTLY as written to the sticker: "${text}"

IMPORTANT: 
- Do NOT translate the text
- Do NOT change the text in any way
- Use the EXACT characters provided by the user

The text should be integrated naturally and visually appealing - it can appear on a sign, banner, speech bubble, or creatively placed within the image. Keep the same character, style, and colors.`;
}
```

### worker.ts — Добавить обработку generationType "text"

```typescript
const generationType =
  session.generation_type || 
  (session.state === "processing_emotion" ? "emotion" : 
   session.state === "processing_motion" ? "motion" :
   session.state === "processing_text" ? "text" : "style");

// Для text используем last_sticker_file_id как source
const sourceFileId =
  generationType === "emotion" || generationType === "motion" || generationType === "text"
    ? session.last_sticker_file_id
    : session.current_photo_file_id || photos[photos.length - 1];
```

## Стоимость

1 кредит (аналогично эмоции/движению)

## Checklist

- [x] SQL миграция: добавить `wait_text`, `processing_text` в enum (`sql/019_add_text.sql`)
- [x] SQL миграция: добавить `text_prompt` поле в sessions
- [x] SQL миграция: добавить локализацию
- [x] Добавить fallback тексты в `texts.ts`
- [x] Добавить `buildTextPrompt` функцию в `index.ts`
- [x] Добавить callback handler `add_text:ID` в `index.ts`
- [x] Добавить обработку `wait_text` в text handler
- [x] Добавить кнопку в replyMarkup после генерации стикера (`worker.ts`)
- [x] Обновить `startGeneration` для поддержки `generationType: "text"`
- [x] Обновить `worker.ts` для обработки `processing_text`
- [ ] Тестирование с русским и английским текстом
