# 06-03-replace-subject-from-sticker

## Контекст

Пользователь хочет взять любой стикер (свой или чужой) и применить к нему стандартные действия бота: сменить эмоцию, движение, добавить текст, обводку — **плюс** новая кнопка «Заменить лицо» (перегенерировать стикер с лицом из ранее присланного фото пользователя).

Сейчас бот работает только со стикерами, которые сам сгенерировал. Нового flow «принять стикер извне» нет.

---

## Цель MVP

Добавить отдельный flow **«Изменить стикер»**:

1. В **главном меню** появляется новая кнопка.
2. Пользователь **присылает стикер** (любой — свой из истории или пересланный).
3. Бот принимает стикер и показывает **стандартные action-кнопки** (как после генерации: Эмоция, Движение, Текст, Обводка, Идеи).
4. Дополнительно показывается новая кнопка **«🧑 Заменить лицо»**.
5. При нажатии «Заменить лицо» бот берёт `current_photo_file_id` пользователя (фото, которое он присылал ранее) и генерирует новый стикер с тем же стилем/позой, но с лицом пользователя.

---

## Scope

### In scope
- Новая кнопка в главном меню: `🎨 Изменить стикер` / `🎨 Edit sticker`.
- Приём стикера от пользователя (Telegram sticker message).
- Показ стандартных action-кнопок + новая кнопка «🧑 Заменить лицо».
- Генерация `replace_subject`: стикер как pose-reference + фото пользователя как identity-reference.
- Списание 1 кредита (как обычная style-генерация).

### Out of scope
- Face swap с точной геометрией 1:1.
- Массовая замена в паке.
- Выбор конкретного лица, если на фото несколько человек.

---

## UX flow (пошагово)

### Шаг 1 — Вход
Пользователь нажимает кнопку **«🎨 Изменить стикер»** в главном меню (persistent keyboard).

### Шаг 2 — Запрос стикера
Бот отвечает:
- RU: `Пришли стикер, который хочешь изменить`
- EN: `Send the sticker you want to edit`

Состояние сессии: `state = "wait_edit_sticker"`.

### Шаг 3 — Приём стикера
Пользователь отправляет стикер (Telegram sticker message). Бот:
1. Извлекает `file_id` стикера из `ctx.message.sticker.file_id`.
2. Скачивает стикер через Telegram API и сохраняет `file_id` в сессии как `last_sticker_file_id`.
3. Также сохраняет `file_id` в `source_photo_file_id` (для chain: emotion/motion берут source отсюда).
4. Переводит сессию в `state = "wait_edit_action"`.
5. Отправляет стикер обратно пользователю (для контекста) с action-кнопками.

### Шаг 4 — Action-кнопки
Кнопки под стикером (inline keyboard):

```
[😊 Эмоция] [🏃 Движение]
[🔲 Обводка] [✏️ Текст]
[🧑 Заменить лицо]
```

Callback data:
- `change_emotion:<stickerId>` — переиспользует существующий handler
- `change_motion:<stickerId>` — переиспользует существующий handler
- `toggle_border:<stickerId>` — переиспользует существующий handler
- `add_text:<stickerId>` — переиспользует существующий handler
- `replace_face:<stickerId>` — **новый** callback

> **Важно:** `<stickerId>` — это НЕ id из таблицы `stickers` (стикер внешний, его нет в БД). Это специальный временный id. См. раздел «БД».

### Шаг 5 — «Заменить лицо» (новая кнопка)

При нажатии `replace_face:<tempStickerId>`:

1. Проверяем, что у пользователя есть фото (`current_photo_file_id` в сессии или `last_photo_file_id` в users).
2. Если фото **нет** — просим прислать:
   - RU: `Сначала пришли своё фото, а потом нажми "Заменить лицо" ещё раз`
   - EN: `First send your photo, then tap "Replace face" again`
   - Переводим `state = "wait_edit_photo"`.
   - После получения фото — возвращаем кнопки (повторно показываем стикер с action-кнопками).
3. Если фото **есть** — запускаем генерацию `replace_subject`.

### Шаг 6 — Генерация replace_subject

1. Списываем 1 кредит (через стандартный `deductCredits`). Если кредитов нет — paywall.
2. Создаём job в `jobs` (как обычная генерация), устанавливаем `state = "processing"`.
3. Worker обрабатывает job (см. раздел Worker).
4. Результат — новый стикер с action-кнопками (стандартный flow после генерации).

---

## Изменения в коде: `src/index.ts`

### 1. Главное меню: `getMainMenuKeyboard()`

Файл: `src/index.ts`, функция `getMainMenuKeyboard` (~строка 1697).

**Что сделать:** добавить кнопку `🎨 Изменить стикер` / `🎨 Edit sticker` в `row1`.

```typescript
// БЫЛО:
const row1 = lang === "ru"
  ? ["✨ Создать стикер", "📦 Создать пак"]
  : ["✨ Create sticker", "📦 Create pack"];

// СТАЛО:
const row1 = lang === "ru"
  ? ["✨ Создать стикер", "🎨 Изменить стикер", "📦 Создать пак"]
  : ["✨ Create sticker", "🎨 Edit sticker", "📦 Create pack"];
```

> Для admin-вариантов (с `showAdminGenerate`, `showAdminMakeExample`) — тоже добавить `🎨 Изменить стикер` / `🎨 Edit sticker` во все ветки `row1`.

### 2. Обработчик кнопки меню (text handler)

Файл: `src/index.ts`, внутри `bot.on("text", ...)` (~строка 6207).

**Что сделать:** добавить обработку текста `🎨 Изменить стикер` / `🎨 Edit sticker` ДО проверок существующих text-команд.

```typescript
// В начале text handler, после получения user и session:
if (msgText === "🎨 Изменить стикер" || msgText === "🎨 Edit sticker") {
  // Закрываем предыдущие активные сессии (как при "✨ Создать стикер")
  await supabase
    .from("sessions")
    .update({ is_active: false })
    .eq("user_id", user.id)
    .eq("env", config.appEnv)
    .eq("is_active", true);

  // Создаём новую сессию
  const { data: newSession } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: "wait_edit_sticker",
      is_active: true,
      env: config.appEnv,
      flow_kind: "edit_sticker",
    })
    .select()
    .single();

  await ctx.reply(
    lang === "ru"
      ? "Пришли стикер, который хочешь изменить 👇"
      : "Send the sticker you want to edit 👇",
    getMainMenuKeyboard(lang, telegramId)
  );
  return;
}
```

### 3. Обработчик стикера (новый handler)

Файл: `src/index.ts`.

**Что сделать:** добавить `bot.on("sticker", ...)` handler. Telegraf поддерживает `ctx.message.sticker`.

```typescript
bot.on("sticker", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const session = await getActiveSession(user.id);
  if (!session?.id || session.state !== "wait_edit_sticker") {
    // Стикер пришёл не в том состоянии — игнорируем или подсказываем
    return;
  }

  const stickerFileId = ctx.message.sticker.file_id;

  // Сохраняем стикер как "внешний" — записываем в edit_sticker_file_id и last_sticker_file_id
  const nextRev = (session.session_rev || 1) + 1;
  await supabase
    .from("sessions")
    .update({
      state: "wait_edit_action",
      last_sticker_file_id: stickerFileId,
      edit_sticker_file_id: stickerFileId,
      is_active: true,
      flow_kind: "edit_sticker",
      session_rev: nextRev,
    })
    .eq("id", session.id);

  // Сохраняем "стикер" в stickers как внешний (generation_type = "imported")
  // чтобы получить stickerId для callback_data кнопок
  const { data: importedSticker } = await supabase
    .from("stickers")
    .insert({
      user_id: user.id,
      session_id: session.id,
      telegram_file_id: stickerFileId,
      source_photo_file_id: stickerFileId,
      generation_type: "imported",
      env: config.appEnv,
    })
    .select("id")
    .single();

  const stickerId = importedSticker?.id;
  if (!stickerId) {
    await ctx.reply(lang === "ru" ? "Ошибка, попробуй ещё раз." : "Error, please try again.");
    return;
  }

  // Показываем стикер с action-кнопками
  const sessionRef = formatCallbackSessionRef(session.id, nextRev);
  const emotionCb = `change_emotion:${stickerId}:${sessionRef}`;
  const motionCb = `change_motion:${stickerId}:${sessionRef}`;

  const changeEmotionText = lang === "ru" ? "😊 Эмоция" : "😊 Emotion";
  const changeMotionText = lang === "ru" ? "🏃 Движение" : "🏃 Motion";
  const toggleBorderText = lang === "ru" ? "🔲 Обводка" : "🔲 Border";
  const addTextText = lang === "ru" ? "✏️ Текст" : "✏️ Text";
  const replaceFaceText = lang === "ru" ? "🧑 Заменить лицо" : "🧑 Replace face";

  await ctx.reply(
    lang === "ru" ? "Что хочешь сделать с этим стикером?" : "What do you want to do with this sticker?",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: changeEmotionText, callback_data: emotionCb },
            { text: changeMotionText, callback_data: motionCb },
          ],
          [
            { text: toggleBorderText, callback_data: `toggle_border:${stickerId}` },
            { text: addTextText, callback_data: `add_text:${stickerId}` },
          ],
          [
            { text: replaceFaceText, callback_data: `replace_face:${stickerId}:${sessionRef}` },
          ],
        ],
      },
    }
  );
});
```

### 4. Callback handler: `replace_face`

Файл: `src/index.ts`.

```typescript
bot.action(/^replace_face:([^:]+)(?::(.+))?$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;
  const lang = user.lang || "en";

  const stickerId = ctx.match[1];
  const { sessionId: explicitSessionId } = parseCallbackSessionRef(ctx.match?.[2] || null);
  const session = await resolveSessionForCallback(user.id, explicitSessionId);
  if (!session?.id) {
    await rejectSessionEvent(ctx, lang, "replace_face", "session_not_found");
    return;
  }

  // Определяем фото пользователя
  const userPhotoFileId =
    session.current_photo_file_id || user.last_photo_file_id;

  if (!userPhotoFileId) {
    // Фото нет — просим прислать
    await supabase
      .from("sessions")
      .update({
        state: "wait_edit_photo",
        is_active: true,
        edit_replace_sticker_id: stickerId,
      })
      .eq("id", session.id);

    await ctx.reply(
      lang === "ru"
        ? "📸 Сначала пришли своё фото — я заменю лицо на стикере."
        : "📸 First send your photo — I'll replace the face on the sticker."
    );
    return;
  }

  // Фото есть — проверяем кредиты
  if ((user.credits || 0) < 1) {
    await sendPaywall(ctx, user, lang);
    return;
  }

  // Получаем стикер из БД
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker?.telegram_file_id) {
    await ctx.reply(lang === "ru" ? "Стикер не найден." : "Sticker not found.");
    return;
  }

  // Запускаем генерацию
  const nextRev = (session.session_rev || 1) + 1;
  await supabase
    .from("sessions")
    .update({
      state: "processing",
      is_active: true,
      current_photo_file_id: userPhotoFileId,
      last_sticker_file_id: sticker.telegram_file_id,
      generation_type: "replace_subject",
      edit_replace_sticker_id: stickerId,
      session_rev: nextRev,
    })
    .eq("id", session.id);

  // Списываем кредит
  await supabase
    .from("users")
    .update({ credits: (user.credits || 1) - 1 })
    .eq("id", user.id);

  // Создаём job
  await supabase.from("jobs").insert({
    session_id: session.id,
    status: "pending",
    env: config.appEnv,
  });

  await sendProgressStart(ctx, session.id, lang);
});
```

### 5. Photo handler: state `wait_edit_photo`

Файл: `src/index.ts`, внутри `bot.on("photo", ...)`.

**Что сделать:** добавить блок для `session.state === "wait_edit_photo"` ПЕРЕД блоком global replacement photo router.

```typescript
// Внутри bot.on("photo", ...) — после получения session и photo:
if (session.state === "wait_edit_photo") {
  // Пользователь прислал фото для replace_face
  const photos = Array.isArray(session.photos) ? session.photos : [];
  photos.push(photo.file_id);

  await supabase
    .from("sessions")
    .update({
      photos,
      current_photo_file_id: photo.file_id,
      state: "wait_edit_action",
      is_active: true,
    })
    .eq("id", session.id);

  // Обновляем last_photo_file_id на user (для будущих replace)
  await supabase.from("users").update({ last_photo_file_id: photo.file_id }).eq("id", user.id);

  // Показываем action-кнопки заново с replace_face
  const stickerId = session.edit_replace_sticker_id;
  if (stickerId) {
    const sessionRef = formatCallbackSessionRef(session.id, session.session_rev);
    await ctx.reply(
      lang === "ru" ? "Фото получено! Теперь нажми \"Заменить лицо\" 👇" : "Photo received! Now tap \"Replace face\" 👇",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: lang === "ru" ? "🧑 Заменить лицо" : "🧑 Replace face", callback_data: `replace_face:${stickerId}:${sessionRef}` }],
          ],
        },
      }
    );
  } else {
    await ctx.reply(lang === "ru" ? "Фото сохранено! Пришли стикер заново." : "Photo saved! Send the sticker again.");
  }
  return;
}
```

---

## Изменения в коде: `src/worker.ts`

### Новый generation type: `replace_subject`

Файл: `src/worker.ts`, функция `runJob` (~строка 1326).

**Что сделать:** в блоке определения `generationType` (~строка 1388) добавить:

```typescript
const generationType =
  session.state === "processing_emotion" ? "emotion" :
  session.state === "processing_motion" ? "motion" :
  session.state === "processing_text" ? "text" :
  session.generation_type || "style";
```

Значение `"replace_subject"` придёт из `session.generation_type`. Дополнительных изменений в этом блоке не нужно.

**Главное изменение:** в блоке определения `sourceFileId` (~строка 1410):

```typescript
// БЫЛО:
const sourceFileId =
  generationType === "emotion" || generationType === "motion" || generationType === "text"
    ? session.last_sticker_file_id
    : session.current_photo_file_id || photos[photos.length - 1];

// СТАЛО:
const sourceFileId =
  generationType === "emotion" || generationType === "motion" || generationType === "text"
    ? session.last_sticker_file_id
    : generationType === "replace_subject"
      ? session.current_photo_file_id  // фото пользователя (identity source)
      : session.current_photo_file_id || photos[photos.length - 1];
```

**Второй image input:** для `replace_subject` нужно передать стикер как второй референс. После скачивания `sourceFileId` (~строка 1430):

```typescript
// После:
// const base64 = fileBuffer.toString("base64");
// const mimeType = getMimeTypeByTelegramPath(filePath);

// Добавить:
let referenceBase64: string | null = null;
let referenceMime: string | null = null;
if (generationType === "replace_subject" && session.last_sticker_file_id) {
  const refPath = await getFilePath(session.last_sticker_file_id);
  const refBuffer = await downloadFile(refPath);
  referenceBase64 = refBuffer.toString("base64");
  referenceMime = getMimeTypeByTelegramPath(refPath);
}
```

**Промпт для replace_subject:** перед вызовом Gemini (~строка 1444):

```typescript
if (generationType === "replace_subject") {
  promptForGeneration = `You are given two images:
1) REFERENCE PHOTO — the person whose face and identity to use.
2) STICKER REFERENCE — a sticker showing a pose, emotion, and art style to replicate.

Your task:
- Generate a NEW sticker of the person from the REFERENCE PHOTO.
- Copy the EXACT pose, emotion, body language, and art style from the STICKER REFERENCE.
- The face and body proportions must match the REFERENCE PHOTO (identity transfer).
- One person only. No text on the sticker.
- Background: flat uniform BRIGHT MAGENTA (#FF00FF).
- Character must be FULLY visible with 15% padding on all sides.
- Do NOT draw outlines, borders, or strokes around the character.
- Output aspect ratio: 1:1.`;
}
```

**Вызов Gemini с двумя images:** в `callGeminiImage` (~строка 1489) для `replace_subject` передаём 2 image parts:

```typescript
// В callGeminiImage или рядом — специальный вызов для replace_subject:
if (generationType === "replace_subject" && referenceBase64 && referenceMime) {
  geminiRes = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`,
    {
      contents: [{
        role: "user",
        parts: [
          { text: promptForGeneration },
          { inlineData: { mimeType, data: base64 } },            // фото пользователя
          { inlineData: { mimeType: referenceMime, data: referenceBase64 } }, // стикер-референс
        ],
      }],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
        imageConfig: { aspectRatio: "1:1" },
      },
    },
    { headers: { "x-goog-api-key": config.geminiApiKey } }
  );
} else {
  // стандартный вызов для style/emotion/motion/text (без изменений)
  geminiRes = await callGeminiImage(promptForGeneration, activeModel, "primary");
}
```

**Сохранение стикера:** при insert в `stickers` (~строка 1902) — generation_type уже придёт из session, дополнительно:

```typescript
// В insert добавить generation_type:
{
  // ...существующие поля...
  generation_type: generationType === "replace_subject" ? "replace_subject" : undefined,
}
```

> Если колонка `generation_type` не существует в `stickers` — нужна миграция (см. ниже).

---

## Изменения в БД

### Миграция 1: колонка `generation_type` в `stickers`

Если колонки `generation_type` ещё нет:

```sql
-- sql/072_stickers_generation_type.sql
ALTER TABLE stickers
  ADD COLUMN IF NOT EXISTS generation_type text DEFAULT NULL;

COMMENT ON COLUMN stickers.generation_type IS 'Type: style, emotion, motion, text, replace_subject, imported';
```

### Миграция 2: поля edit flow в `sessions`

```sql
-- sql/073_sessions_edit_sticker_fields.sql
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS edit_sticker_file_id text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS edit_replace_sticker_id text DEFAULT NULL;

COMMENT ON COLUMN sessions.edit_sticker_file_id IS 'Telegram file_id of externally sent sticker (edit flow)';
COMMENT ON COLUMN sessions.edit_replace_sticker_id IS 'stickers.id of imported sticker for replace_face callback';
```

> **Правило:** посмотреть последний номер в `sql/` и использовать следующий. Номера 072/073 — примерные, заменить на актуальные.

---

## Тексты (`src/lib/texts.ts`)

Добавить ключи:

| Ключ | RU | EN |
|---|---|---|
| `btn.edit_sticker` | `🎨 Изменить стикер` | `🎨 Edit sticker` |
| `edit.send_sticker` | `Пришли стикер, который хочешь изменить 👇` | `Send the sticker you want to edit 👇` |
| `edit.what_to_do` | `Что хочешь сделать с этим стикером?` | `What do you want to do with this sticker?` |
| `btn.replace_face` | `🧑 Заменить лицо` | `🧑 Replace face` |
| `edit.need_photo` | `📸 Сначала пришли своё фото — я заменю лицо на стикере.` | `📸 First send your photo — I'll replace the face on the sticker.` |
| `edit.photo_received` | `Фото получено! Теперь нажми "Заменить лицо" 👇` | `Photo received! Now tap "Replace face" 👇` |

---

## Ошибки и fallback

| Ситуация | Действие |
|---|---|
| Стикер не пришёл (пользователь прислал фото/текст в state `wait_edit_sticker`) | Напомнить: «Пришли стикер» |
| Фото не существует при `replace_face` | Попросить фото, перевести в `wait_edit_photo` |
| Кредитов нет | Показать paywall (стандартный) |
| Gemini не вернул изображение | Стандартный retry/fallback из worker |
| Animated sticker (`.tgs`) / video sticker (`.webm`) | Показать ошибку: «Пока поддерживаются только статичные стикеры» |

---

## Кредиты

- `replace_subject` списывает **1 кредит** (как обычная style-генерация).
- Emotion/motion/text/border для импортированного стикера списывают кредиты по стандартным правилам.

---

## Definition of Done

- [ ] Кнопка `🎨 Изменить стикер` в главном меню (оба языка, все варианты admin/non-admin).
- [ ] `bot.on("sticker")` handler: принимает стикер в state `wait_edit_sticker`, сохраняет, показывает кнопки.
- [ ] Стандартные action-кнопки (эмоция, движение, текст, обводка) работают на импортированном стикере.
- [ ] Кнопка `replace_face` → запрашивает фото если нет → генерирует replace_subject.
- [ ] Worker: `replace_subject` с двумя image inputs → Gemini → результат.
- [ ] Миграции применены.
- [ ] Тексты добавлены в `texts.ts`.
- [ ] Smoke-тесты на test bot:
  1. Happy path: стикер → replace face → результат.
  2. Стикер → эмоция → результат.
  3. Нет фото → просьба → фото → replace.
  4. Нет кредитов → paywall.
  5. Animated sticker → ошибка.

## Checklist реализации

- [ ] Миграция: `generation_type` в `stickers` (если нет)
- [ ] Миграция: `edit_sticker_file_id`, `edit_replace_sticker_id` в `sessions`
- [ ] `getMainMenuKeyboard()` — добавить кнопку в `row1`
- [ ] Text handler — обработка `🎨 Изменить стикер` / `🎨 Edit sticker`
- [ ] `bot.on("sticker", ...)` — новый handler
- [ ] `bot.action(/^replace_face:/)` — новый callback
- [ ] Photo handler — блок для `wait_edit_photo`
- [ ] Worker: `replace_subject` sourceFileId + referenceBase64 + prompt
- [ ] Worker: вызов Gemini с 2 image parts
- [ ] Worker: insert с `generation_type`
- [ ] Тексты в `texts.ts`
- [ ] Animated/video sticker guard
