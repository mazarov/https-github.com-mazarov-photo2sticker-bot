# AI Pack Ideas — генератор идей для стикерпака

**Дата:** 2026-02-11
**Статус:** Спецификация

---

## Проблема

После генерации стикера пользователь не знает что делать дальше. Стикерпак из 1-2 штук — не пак. Большинство пользователей делают 1-2 генерации и уходят.

## Решение

Кнопка **"💡 Идеи для пака"** после каждой генерации. AI анализирует стикер и предлагает 8-10 уникальных идей для дополнительных стикеров в том же стиле. Пользователь листает идеи по одной и нажимает "Сгенерить" — один клик.

## Бизнес-эффект

- Вместо 1-2 генераций за сессию → 5-10 = **x3-5 расход кредитов**
- Полноценный стикерпак за 5 минут без усилий
- Рост LTV и retention

---

## Флоу

```
1. Пользователь генерирует стикер (любой тип: стиль, эмоция, движение, текст)

2. Бот отправляет стикер + кнопки (как сейчас) + НОВАЯ кнопка:
   [😂 Эмоция] [🏃 Движение] [💬 Текст]
   [💡 Идеи для пака]                        ← НОВОЕ
   [📷 Новое фото] [🛒 Купить кредиты]

3. Клик "💡 Идеи для пака":
   - AI (GPT-4o при наличии OPENAI_API_KEY, иначе Gemini Flash) получает: стикер-изображение + стиль + контекст
   - Генерирует 8-10 идей (текстовый запрос, не картинка)
   - Идеи кешируются в сессии
   - Показывается первая идея

4. Сообщение с идеей:
   ┌──────────────────────────────────────────┐
   │  💡 Идея 1 из 8                          │
   │                                          │
   │  😂 Хохочет до слёз                      │
   │  Персонаж смеётся, держась за живот      │
   │                                          │
   │  [🎨 Сгенерить (1💎)] [➡️ Следующая]    │
   │  [✅ Хватит]                              │
   └──────────────────────────────────────────┘

5a. Клик "🎨 Сгенерить":
    - Проверка кредитов (1 кредит)
    - Если нет кредитов → paywall (как обычно)
    - Генерация: оригинальное фото + тот же стиль + promptModification из идеи
    - Стикер отправляется пользователю + добавляется в пак
    - Идея помечается как "сгенерирована"
    - Автоматически показывается следующая идея

5b. Клик "➡️ Следующая":
    - Показывает следующую идею (без генерации, бесплатно)

5c. Клик "✅ Хватит":
    - "🎉 Отлично! В твоём паке уже N стикеров"
    - Кнопки: [📷 Новое фото] [💡 Ещё идеи]

6. Когда идеи закончились:
   - "Все 8 идей показаны! Сгенерировано: N из 8"
   - Кнопка: [🔄 Новые идеи] → AI генерирует ещё 8
```

---

## Типы идей (категории)

AI должен предлагать микс из разных категорий для разнообразного пака:

| Категория | Пример | Текст на стикере | Кол-во в наборе |
|-----------|--------|---|---|
| **Эмоция** | Хохочет, злится, плачет, в шоке, смущён | Опционально ("ХАХАХА") | 2-3 |
| **Действие/поза** | Машет рукой, показывает класс, бежит, танцует | Нет | 1-2 |
| **Сцена** | С кофе утром, за компьютером, на вечеринке | Нет | 1-2 |
| **Текст-мем** | С речевым пузырём или табличкой | Да ("ОК", "Жиза", "Нет", "Ору") | 2-3 |
| **Праздничный** | С тортом, с шариками, с подарком | Опционально ("С ДР!") | 0-1 |
| **Стиль одежды/образ** | В костюме супергероя, в пижаме, с короной | Нет | 0-1 |

**Правило:** в наборе из 8 идей минимум 2 с текстом, минимум 2 эмоции, минимум 1 действие.

---

## Дедупликация

AI не должен предлагать идеи, которые пользователь **уже сгенерировал** в текущей сессии.

Входные данные для дедупликации (передаются AI):
- Список уже сгенерированных эмоций (`session.generated_emotions[]`)
- Список уже сгенерированных движений (`session.generated_motions[]`)
- Список ранее предложенных идей (если просят "Новые идеи")

**Пример в промпте:**
```
Already generated stickers in this pack:
- Style: anime_classic (initial sticker)
- Emotion: laughing
- Motion: waving hand

Do NOT suggest ideas similar to these. All ideas must be unique.
```

---

## Формат данных идеи

```typescript
interface StickerIdea {
  id: string;                    // "idea_1" — для callback_data
  emoji: string;                 // "😂"
  titleRu: string;               // "Хохочет до слёз"
  titleEn: string;               // "Laughing hard"
  descriptionRu: string;         // "Персонаж смеётся, держась за живот"
  descriptionEn: string;         // "Character laughing, holding belly"
  promptModification: string;    // "laughing hysterically, holding belly, tears of joy"
  hasText: boolean;              // true — на стикере будет текст
  textSuggestion?: string;       // "ХАХАХА" — текст для стикера
  textPlacement?: string;        // "speech_bubble" | "sign" | "bottom_caption"
  category: string;              // "emotion" | "action" | "scene" | "text_meme" | "holiday" | "outfit"
  generated?: boolean;           // true после генерации (для трекинга)
}
```

---

## Генерация идей (AI-запрос)

### Модель
**GPT-4o** (при OPENAI_API_KEY) или **Gemini 2.5 Flash** (fallback) — анализ изображения + генерация JSON идей.

### Входные данные
1. Сгенерированный стикер (изображение) — для анализа персонажа
2. `style_preset_id` + `prompt_hint` стиля
3. Язык пользователя (ru/en)
4. Список уже сгенерированных стикеров в паке

### System prompt

```
You are a professional sticker pack designer. Analyze the sticker image and create
a set of 8 unique ideas for additional stickers in the same style to build a complete
sticker pack.

The user's sticker style: {style_name} ({prompt_hint})

Already existing stickers in the pack (DO NOT repeat similar ideas):
{existing_stickers_list}

Rules:
1. Each idea must be visually distinct from all others
2. Mix categories for a well-rounded pack:
   - 2-3 emotion ideas (happy, angry, sad, shocked, shy, etc.)
   - 1-2 action/pose ideas (waving, thumbs up, running, dancing)
   - 2-3 text/meme ideas with short text on the sticker
   - 1-2 scene ideas (morning coffee, working, party)
3. For text ideas:
   - Suggest short text (1-3 words) in {language}
   - Text should be casual/memey: "ОК", "Нет", "Жиза", "Привет!", "Ору", "Спасибо"
   - Specify placement: speech_bubble, sign, or bottom_caption
4. promptModification must be in English, detailed enough for image generation
5. Keep the same character/subject from the original sticker

Return a JSON array of exactly 8 ideas in this format:
[{
  "emoji": "😂",
  "titleRu": "Хохочет до слёз",
  "titleEn": "Laughing hard",
  "descriptionRu": "Персонаж смеётся, держась за живот",
  "descriptionEn": "Character laughing hysterically, holding belly",
  "promptModification": "laughing hysterically, holding belly, tears of joy, mouth wide open",
  "hasText": false,
  "textSuggestion": null,
  "textPlacement": null,
  "category": "emotion"
}]
```

### Стоимость
- Генерация идей: **бесплатно** для пользователя (текстовый запрос к Flash ≈ $0.001)
- Генерация стикера из идеи: **1 кредит** (как обычная генерация)

---

## Генерация стикера из идеи

Переиспользуется существующий pipeline `startGeneration()` с модификацией промпта.

### Источник изображения
- **Оригинальное фото** (`session.current_photo_file_id`) — НЕ стикер
- Стиль: тот же `style_preset_id`

### Формирование промпта
Базовый промпт стиля + `promptModification` из идеи:

```typescript
const basePrompt = await getAgentPrompt(stylePresetId, originalPhoto);
const ideaPrompt = `${basePrompt}. Additional direction: ${idea.promptModification}`;
```

### Текст на стикере (для идей с `hasText = true`)

**Гибридный подход:**

| Условие | Метод | Как |
|---------|-------|-----|
| `textPlacement = "speech_bubble"` | В промпте | Добавить в promptModification: `"with speech bubble saying '{text}'"` |
| `textPlacement = "sign"` | В промпте | Добавить: `"holding a sign that reads '{text}'"` |
| `textPlacement = "bottom_caption"` | Overlay | Сгенерировать стикер без текста, наложить текст программно через `image-utils.ts` |

**Логика выбора:**
```typescript
if (idea.hasText && idea.textSuggestion) {
  if (idea.textPlacement === "bottom_caption") {
    // Генерируем без текста, добавляем overlay после
    options.textPrompt = idea.textSuggestion;
    options.generationType = "text";
  } else {
    // Текст через промпт (speech bubble / sign)
    const textInPrompt = idea.textPlacement === "speech_bubble"
      ? `with speech bubble saying "${idea.textSuggestion}"`
      : `holding a sign that reads "${idea.textSuggestion}"`;
    idea.promptModification += `. ${textInPrompt}`;
  }
}
```

---

## Хранение данных

### В таблице sessions (новые колонки)

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS
  pack_ideas jsonb DEFAULT NULL;
-- Массив StickerIdea[], кешируется после генерации AI

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS
  current_idea_index int DEFAULT 0;
-- Индекс текущей показываемой идеи

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS
  generated_from_ideas text[] DEFAULT '{}';
-- Список idea.id которые были сгенерированы
```

### В таблице stickers (опционально)

```sql
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS
  idea_source text DEFAULT NULL;
-- Если стикер сгенерирован из идеи — хранит idea.id для аналитики
```

---

## Callback-кнопки

| callback_data | Описание |
|---|---|
| `pack_ideas:{stickerId}` | Кнопка "💡 Идеи для пака" — запускает генерацию идей |
| `idea_generate:{ideaIndex}` | Кнопка "🎨 Сгенерить" — генерирует стикер из идеи |
| `idea_next` | Кнопка "➡️ Следующая" — показывает следующую идею |
| `idea_done` | Кнопка "✅ Хватит" — завершает просмотр идей |
| `idea_more` | Кнопка "🔄 Новые идеи" — генерирует новый набор из 8 |

---

## Реализация в src/index.ts

### 1. Кнопка "💡 Идеи для пака" — добавляется после каждой генерации

**Где:** В `src/worker.ts`, после отправки стикера пользователю, в блоке формирования кнопок.

Добавить кнопку в inline_keyboard:
```typescript
{ text: "💡 Идеи для пака", callback_data: `pack_ideas:${stickerId}` }
```

### 2. Обработчик pack_ideas

```typescript
bot.action(/^pack_ideas:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const stickerId = ctx.match[1];

  const user = await getUser(ctx.from.id);
  const session = await getActiveSession(user.id);
  const lang = user.lang || "en";

  // Получить стикер для анализа
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, style_preset_id")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker?.telegram_file_id) return;

  // Показать "думаю..."
  const thinkingMsg = await ctx.reply(
    lang === "ru" ? "💡 Придумываю идеи для пака..." : "💡 Thinking of ideas..."
  );

  // Собрать контекст: что уже сгенерировано
  const existingStickers = await getPackContext(session.id);

  // Вызвать AI для генерации идей
  const ideas = await generatePackIdeas({
    stickerFileId: sticker.telegram_file_id,
    stylePresetId: sticker.style_preset_id,
    lang,
    existingStickers,
  });

  // Сохранить идеи в сессию
  await supabase.from("sessions").update({
    pack_ideas: ideas,
    current_idea_index: 0,
    state: "browsing_ideas",
  }).eq("id", session.id);

  // Удалить "думаю..."
  try { await ctx.deleteMessage(thinkingMsg.message_id); } catch {}

  // Показать первую идею
  await showIdea(ctx, ideas[0], 0, ideas.length, lang);
});
```

### 3. Функция показа идеи

```typescript
async function showIdea(
  ctx: any,
  idea: StickerIdea,
  index: number,
  total: number,
  lang: string
) {
  const title = lang === "ru" ? idea.titleRu : idea.titleEn;
  const desc = lang === "ru" ? idea.descriptionRu : idea.descriptionEn;
  const textHint = idea.hasText && idea.textSuggestion
    ? `\n✏️ Текст: "${idea.textSuggestion}"`
    : "";

  const text = `💡 ${lang === "ru" ? "Идея" : "Idea"} ${index + 1}/${total}\n\n`
    + `${idea.emoji} **${title}**\n`
    + `${desc}${textHint}`;

  const generateText = lang === "ru"
    ? `🎨 Сгенерить (1💎)`
    : `🎨 Generate (1💎)`;
  const nextText = lang === "ru" ? "➡️ Следующая" : "➡️ Next";
  const doneText = lang === "ru" ? "✅ Хватит" : "✅ Done";

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: generateText, callback_data: `idea_generate:${index}` },
          { text: nextText, callback_data: "idea_next" },
        ],
        [{ text: doneText, callback_data: "idea_done" }],
      ],
    },
  });
}
```

### 4. Обработчик idea_generate

```typescript
bot.action(/^idea_generate:(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);

  const user = await getUser(ctx.from.id);
  const session = await getActiveSession(user.id);
  const ideaIndex = parseInt(ctx.match[1]);
  const ideas: StickerIdea[] = session.pack_ideas;
  const idea = ideas[ideaIndex];

  if (!idea) return;

  // Пометить идею как сгенерированную
  ideas[ideaIndex].generated = true;

  // Подготовить параметры генерации
  const stylePreset = await getStylePreset(session.selected_style_id);
  let promptFinal = `${stylePreset.prompt_hint}. ${idea.promptModification}`;

  let textPrompt = null;
  let generationType = session.generation_type || "style";

  // Обработка текста
  if (idea.hasText && idea.textSuggestion) {
    if (idea.textPlacement === "bottom_caption") {
      textPrompt = idea.textSuggestion;
      generationType = "text";
    } else {
      // Текст в промпте (speech bubble / sign)
      const textInPrompt = idea.textPlacement === "speech_bubble"
        ? `with speech bubble saying "${idea.textSuggestion}"`
        : `holding a sign that reads "${idea.textSuggestion}"`;
      promptFinal += `. ${textInPrompt}`;
    }
  }

  // startGeneration (переиспользуем существующий pipeline)
  await startGeneration(ctx, user, session, {
    generationType,
    promptFinal,
    textPrompt,
    selectedStyleId: session.selected_style_id,
    userInput: idea.titleEn,
    ideaSource: idea.id, // для аналитики
  });

  // Обновить сессию
  const nextIndex = ideaIndex + 1;
  await supabase.from("sessions").update({
    pack_ideas: ideas,
    current_idea_index: nextIndex,
    generated_from_ideas: [...(session.generated_from_ideas || []), idea.id],
  }).eq("id", session.id);

  // После генерации стикера (в worker.ts) — автоматически показать следующую идею
  // Это делается в worker.ts после отправки стикера
});
```

### 5. Обработчики навигации

```typescript
bot.action("idea_next", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const user = await getUser(ctx.from.id);
  const session = await getActiveSession(user.id);
  const ideas: StickerIdea[] = session.pack_ideas;
  const nextIndex = (session.current_idea_index || 0) + 1;
  const lang = user.lang || "en";

  if (nextIndex >= ideas.length) {
    // Все идеи показаны
    const generated = ideas.filter(i => i.generated).length;
    const text = lang === "ru"
      ? `🎉 Все ${ideas.length} идей показаны! Сгенерировано: ${generated}`
      : `🎉 All ${ideas.length} ideas shown! Generated: ${generated}`;
    await ctx.editMessageText(text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Новые идеи", callback_data: "idea_more" }],
          [{ text: "📷 Новое фото", callback_data: "new_photo" }],
        ],
      },
    });
    return;
  }

  await supabase.from("sessions").update({
    current_idea_index: nextIndex,
  }).eq("id", session.id);

  // Редактируем текущее сообщение с новой идеей
  await showIdeaEdit(ctx, ideas[nextIndex], nextIndex, ideas.length, lang);
});

bot.action("idea_done", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const user = await getUser(ctx.from.id);
  const lang = user.lang || "en";

  // Подсчитать стикеры в паке
  const { count } = await supabase
    .from("stickers")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .not("telegram_file_id", "is", null);

  const text = lang === "ru"
    ? `🎉 Отлично! В твоём паке уже ${count || 0} стикеров`
    : `🎉 Great! Your pack has ${count || 0} stickers`;

  await ctx.editMessageText(text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📷 Новое фото", callback_data: "new_photo" }],
        [{ text: "💡 Ещё идеи", callback_data: "idea_more" }],
      ],
    },
  });
});

bot.action("idea_more", async (ctx) => {
  // Повторный запуск генерации идей с учётом уже сгенерированных
  // Аналогично pack_ideas, но с расширенным existingStickers
  safeAnswerCbQuery(ctx);
  // ... повторная генерация с дедупликацией
});
```

---

## SQL-миграция

```sql
-- 057_pack_ideas.sql

-- Pack ideas in sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_ideas jsonb DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_idea_index int DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS generated_from_ideas text[] DEFAULT '{}';

COMMENT ON COLUMN sessions.pack_ideas IS 'Cached array of StickerIdea[] from AI';
COMMENT ON COLUMN sessions.current_idea_index IS 'Current idea being shown to user';
COMMENT ON COLUMN sessions.generated_from_ideas IS 'Array of idea IDs that were generated';

-- Track idea source in stickers (for analytics)
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS idea_source text DEFAULT NULL;
COMMENT ON COLUMN stickers.idea_source IS 'If sticker was generated from pack idea — stores idea ID';

-- Add browsing_ideas state
-- (no schema change needed, state is text field)
```

---

## Алерт для аналитики

При генерации из идеи — отправлять алерт:
```typescript
sendAlert({
  type: "idea_generated",
  message: "💡 Sticker from pack idea",
  details: {
    user: `@${user.username || user.telegram_id}`,
    ideaTitle: idea.titleEn,
    ideaCategory: idea.category,
    hasText: idea.hasText,
    packSize: packStickersCount,
  },
});
```

---

## Тексты (RU / EN)

| Ключ | RU | EN |
|------|----|----|
| `pack_ideas.button` | 💡 Идеи для пака | 💡 Pack ideas |
| `pack_ideas.thinking` | 💡 Придумываю идеи для пака... | 💡 Thinking of ideas for your pack... |
| `pack_ideas.idea_header` | 💡 Идея {n} из {total} | 💡 Idea {n} of {total} |
| `pack_ideas.generate` | 🎨 Сгенерить (1💎) | 🎨 Generate (1💎) |
| `pack_ideas.next` | ➡️ Следующая | ➡️ Next |
| `pack_ideas.done` | ✅ Хватит | ✅ Done |
| `pack_ideas.all_shown` | 🎉 Все {total} идей показаны! Сгенерировано: {generated} | 🎉 All {total} ideas shown! Generated: {generated} |
| `pack_ideas.more` | 🔄 Новые идеи | 🔄 More ideas |
| `pack_ideas.pack_size` | 🎉 Отлично! В твоём паке уже {count} стикеров | 🎉 Great! Your pack has {count} stickers |
| `pack_ideas.text_hint` | ✏️ Текст: "{text}" | ✏️ Text: "{text}" |

---

## Чеклист реализации

- [ ] SQL-миграция: `pack_ideas`, `current_idea_index`, `generated_from_ideas` в sessions; `idea_source` в stickers
- [x] Функция `generatePackIdeas()` — GPT-4o (или Gemini Flash fallback) с изображением стикера
- [ ] Функция `getPackContext()` — собрать уже сгенерированные стикеры для дедупликации
- [ ] Кнопка "💡 Идеи для пака" после каждой генерации (worker.ts)
- [ ] Обработчик `bot.action(/^pack_ideas/)` — генерация идей
- [ ] Функции `showIdea()` / `showIdeaEdit()` — отображение идеи
- [ ] Обработчик `bot.action(/^idea_generate/)` — генерация стикера из идеи
- [ ] Обработчик `bot.action("idea_next")` — следующая идея
- [ ] Обработчик `bot.action("idea_done")` — завершение
- [ ] Обработчик `bot.action("idea_more")` — новые идеи с дедупликацией
- [ ] Логика текста на стикере: speech_bubble через промпт, bottom_caption через overlay
- [ ] Тексты в bot_texts (RU/EN)
- [ ] Алерт `idea_generated` для аналитики
- [ ] Автопоказ следующей идеи после генерации (в worker.ts)
