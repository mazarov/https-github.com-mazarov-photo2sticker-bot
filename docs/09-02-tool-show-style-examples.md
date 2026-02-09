# Tool: show_style_examples (v2)

## Цель

Ассистент показывает пользователю примеры стикеров в разных стилях, чтобы помочь с выбором. Это:
- Снижает неопределённость ("как будет выглядеть?")
- Ускоряет выбор стиля
- Повышает конверсию (пользователь видит качество до покупки)

---

## UX-флоу

### Шаг 1: LLM вызывает tool (без style_id)
LLM спрашивает "Для какого стиля показать пример?" и вызывает `show_style_examples()` без `style_id`.

Код показывает **inline-кнопки для ВСЕХ активных стилей** + кнопку "🤖 Ассистент":

```
🤖 Ассистент: Для какого стиля показать пример?

[🎨 Аниме]       [🖍 Мультяшный]
[✏️ Минимализм]   [📸 Реалистичный]
[💫 Line art]     [🎭 Поп-арт]
[🤖 Ассистент]
```

Кнопки выводятся **по 2 в ряд**, кнопка "Ассистент" — отдельный ряд снизу.

### Шаг 2: Пользователь нажимает кнопку стиля
Код ищет пример (`is_example = true`) для выбранного стиля:
- **Есть пример** → отправляет стикер
- **Нет примера** → текст "Примера для этого стиля пока нет. Опиши стиль словами — я пойму!"

### Шаг 3: Продолжение диалога
После показа примера ассистент продолжает собирать параметры.

---

## Когда вызывается

LLM вызывает `show_style_examples` когда:
- Пользователь просит показать примеры ("покажи примеры", "что есть?", "какие стили бывают?")
- Пользователь не может определиться со стилем
- LLM считает что пример поможет (пользователь описал стиль неточно)

LLM **не вызывает** если:
- Пользователь уже уверенно назвал стиль
- Все параметры уже собраны

---

## Tool Definition

```typescript
{
  name: "show_style_examples",
  description: "Call to show the user example stickers in different styles. Always call WITHOUT style_id — the code will show buttons for all available styles. User will tap a button to see a specific example. Use when user asks to see examples, can't decide on a style, or when showing examples would help.",
  parameters: {
    type: "object",
    properties: {
      style_id: {
        type: "string",
        description: "Style preset ID to show example for. Usually omit this — let the user pick from buttons. Only pass if user explicitly named a style."
      },
    },
  },
}
```

**Ключевое изменение vs v1:** LLM почти всегда вызывает без `style_id`. Код показывает кнопки, пользователь выбирает сам.

---

## Обработка в коде

### `handleToolCall()` в `assistant-db.ts`

```typescript
if (toolCall.name === "show_style_examples") {
  return {
    updates: {},
    action: "show_examples",
  };
}
```

Без изменений — action `"show_examples"` не меняет данные сессии.

### Обработка action в `index.ts` — `handleShowStyleExamples()`

```typescript
async function handleShowStyleExamples(
  ctx: any,
  styleId: string | undefined | null,
  lang: string
): Promise<void> {
  const isRu = lang === "ru";

  if (styleId) {
    // === Конкретный стиль ===
    if (styleId === "assistant") {
      // Стиль "Ассистент" — примеры из assistant-генераций
      const example = await getAssistantStyleExample();
      if (example?.telegram_file_id) {
        await ctx.replyWithSticker(example.telegram_file_id);
      } else {
        await ctx.reply(isRu
          ? "Примеров от ассистента пока нет."
          : "No assistant examples yet.");
      }
      return;
    }

    const example = await getStyleExample(styleId);
    if (example?.telegram_file_id) {
      await ctx.replyWithSticker(example.telegram_file_id);
    } else {
      await ctx.reply(isRu
        ? "Примера для этого стиля пока нет. Опиши стиль словами — я пойму!"
        : "No example for this style yet. Describe it in words — I'll understand!");
    }
  } else {
    // === Показать кнопки для ВСЕХ стилей ===
    const allStyles = await getStylePresets(); // Все активные стили
    
    // Кнопки по 2 в ряд
    const rows: any[][] = [];
    for (let i = 0; i < allStyles.length; i += 2) {
      const row = [
        Markup.button.callback(
          `${allStyles[i].emoji} ${isRu ? allStyles[i].name_ru : allStyles[i].name_en}`,
          `assistant_example_${allStyles[i].id}`
        ),
      ];
      if (allStyles[i + 1]) {
        row.push(
          Markup.button.callback(
            `${allStyles[i + 1].emoji} ${isRu ? allStyles[i + 1].name_ru : allStyles[i + 1].name_en}`,
            `assistant_example_${allStyles[i + 1].id}`
          )
        );
      }
      rows.push(row);
    }

    // Последний ряд — кнопка "Ассистент"
    rows.push([
      Markup.button.callback(
        `🤖 ${isRu ? "Ассистент" : "Assistant"}`,
        "assistant_example_assistant"
      ),
    ]);

    const header = isRu
      ? "Нажми на стиль, чтобы увидеть пример:"
      : "Tap a style to see an example:";

    await ctx.reply(header, Markup.inlineKeyboard(rows));
  }
}
```

### Новая функция `getAssistantStyleExample()`

```typescript
async function getAssistantStyleExample(): Promise<StyleExample | null> {
  const { data } = await supabase
    .from("stickers")
    .select("telegram_file_id, style_preset_id")
    .eq("selected_style_id", "assistant")
    .eq("is_example", true)
    .not("telegram_file_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  
  return data;
}
```

### Callback для inline-кнопок

```typescript
bot.action(/^assistant_example_(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const styleId = ctx.match[1];
  const telegramId = ctx.from?.id;
  if (!telegramId || !styleId) return;

  try {
    if (styleId === "assistant") {
      // Пример от ассистента
      const example = await getAssistantStyleExample();
      if (example?.telegram_file_id) {
        await ctx.replyWithSticker(example.telegram_file_id);
      } else {
        const user = await getUser(telegramId);
        const lang = user?.lang || "en";
        await ctx.reply(lang === "ru"
          ? "Примеров от ассистента пока нет."
          : "No assistant examples yet.");
      }
      return;
    }

    const example = await getStyleExample(styleId);
    if (example?.telegram_file_id) {
      await ctx.replyWithSticker(example.telegram_file_id);
    } else {
      const user = await getUser(telegramId);
      const lang = user?.lang || "en";
      await ctx.reply(lang === "ru"
        ? "Примера для этого стиля пока нет."
        : "No example available for this style yet.");
    }
  } catch (err: any) {
    console.error("assistant_example callback error:", err.message);
  }
});
```

### Fallback (если LLM вернул только tool call без текста)

```typescript
if (action === "show_examples") {
  return isRu
    ? "Нажми на стиль, чтобы увидеть пример:"
    : "Tap a style to see an example:";
}
```

---

## System Prompt

```
## Style Examples
You can show style examples to help users choose.
- Call show_style_examples() WITHOUT style_id — code will show buttons for ALL styles
- User taps a button to see a specific example sticker
- Only pass style_id if user explicitly named a specific style
- Use when user is unsure about style, asks to see options, or can't decide
- After showing examples, continue collecting parameters normally
```

---

## Данные для [SYSTEM STATE]

В `buildStateInjection()` — список доступных стилей:

```typescript
if (options?.availableStyles && options.availableStyles.length > 0) {
  const styleList = options.availableStyles.map(s => s.id).join(", ");
  lines.push(`Available style IDs for examples: ${styleList}`);
}
```

---

## Стиль "Ассистент"

### Что это
Псевдо-стиль, показывающий примеры стикеров которые были сгенерированы через AI-ассистента (где `selected_style_id = 'assistant'` в таблице `stickers`).

### Как пометить стикер как пример ассистента
В Supabase вручную:
```sql
UPDATE stickers SET is_example = true WHERE id = '<sticker_uuid>';
```

### Отличие от обычных стилей
- Не существует в таблице `style_presets` — это виртуальная кнопка
- Поиск примеров: `selected_style_id = 'assistant'` + `is_example = true`
- Кнопка всегда последняя в списке

---

## Существующая инфраструктура

Уже реализовано:

| Функция | Файл | Что делает |
|---|---|---|
| `getStylePresets()` | `index.ts` | Все активные стили из `style_presets` (кеш 5 мин) |
| `getStyleExample(styleId, offset)` | `index.ts` | Пример стикера по `style_preset_id` |
| `countStyleExamples(styleId)` | `index.ts` | Количество примеров для стиля |
| `handleShowStyleExamples()` | `index.ts` | **Обновить** — новая логика с кнопками для всех стилей |
| `getStylesWithExamples()` | `index.ts` | **Удалить** — больше не нужна, показываем ВСЕ стили |

Новое:

| Функция | Файл | Что делает |
|---|---|---|
| `getAssistantStyleExample()` | `index.ts` | Пример стикера от ассистента |

Таблица `stickers`:
- `is_example: boolean` — помечен ли стикер как пример
- `style_preset_id: text` — привязка к стилю (для обычных стилей)
- `selected_style_id: text` — `"assistant"` для ассистент-генераций
- `telegram_file_id: text` — file_id для отправки через Telegram API

---

## Файлы для изменений

| Файл | Что менять |
|---|---|
| `src/lib/ai-chat.ts` | Обновить описание tool — LLM вызывает без style_id, код покажет кнопки |
| `src/index.ts` | `handleShowStyleExamples()` — показывать ВСЕ стили + "Ассистент", кнопки по 2 в ряд |
| `src/index.ts` | Добавить `getAssistantStyleExample()` |
| `src/index.ts` | Обновить callback `assistant_example_*` — обработка `"assistant"` id |
| `src/index.ts` | Удалить `getStylesWithExamples()` (больше не нужна) |
| `src/index.ts` | Обновить fallback для `show_examples` |

**Оценка: ~1 час**

---

## Ограничения

- Показываем 1 пример за раз (один стикер на нажатие кнопки)
- Кнопки показываются для ВСЕХ активных стилей, даже если примера нет (при нажатии — сообщение "нет примера")
- Стиль "Ассистент" — виртуальный, не из `style_presets`
- LLM не видит сам стикер — только знает что код его отправил
- `telegram_file_id` привязан к боту: примеры из прод-бота не работают в тест-боте
