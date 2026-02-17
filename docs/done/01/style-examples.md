# Style Examples — Примеры стилей

## Цель
Показать пользователю как выглядит результат генерации для каждого стиля перед выбором.

## Scope
- ✅ Только стили (style_presets)
- ❌ Эмоции — не трогаем
- ❌ Движения — не трогаем
- ❌ Текст — не трогаем

## Архитектура

### Подход
- Примеры отмечаются на уровне стикера (`is_example = true`)
- Админ выбирает примеры вручную через канал алертов
- Каждый стикер привязан к своему стилю
- Приватность — ручная модерация (на ответственности админа)

### Флоу добавления примера

```
1. Пользователь генерирует стикер
2. В канал алертов приходит:
   
   🎨 Новый стикер
   👤 @username
   📦 Стиль: Аниме
   [Сделать примером]

3. Админ нажимает кнопку
4. Стикер помечается is_example = true
5. Появляется в примерах для стиля "Аниме"
```

## UI для пользователя

### Выбор стиля (с кнопками примеров)

```
Бот: "Выбери стиль:"
     [🎌 Аниме] [Пример]
     [👾 Пиксель] [Пример]
     [🎮 3D] [Пример]
     [🎬 Мультик] [Пример]
```

### Показ примеров (по одному, макс 3)

```
Клик "Пример" →
  [Стикер 1]
  "Пример стиля Аниме"
  [Ещё] [← Назад]

Клик "Ещё" →
  [Стикер 2]
  [Ещё] [← Назад]

Клик "Ещё" →
  [Стикер 3]
  [← Назад]           ← "Ещё" пропадает после 3-го

Если примеров меньше 3:
  "Больше примеров нет"
  [← Назад]
```

## База данных

### Миграция

```sql
-- 034_style_examples.sql

-- Добавить поля в stickers
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS is_example boolean DEFAULT false;
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS style_preset_id text;

-- Индекс для быстрого поиска примеров
CREATE INDEX IF NOT EXISTS idx_stickers_examples 
ON stickers (style_preset_id, is_example, created_at DESC) 
WHERE is_example = true;

-- Заполнить style_preset_id из sessions для существующих стикеров
UPDATE stickers s
SET style_preset_id = ses.selected_style_id
FROM sessions ses
WHERE s.session_id = ses.id
  AND s.style_preset_id IS NULL
  AND ses.selected_style_id IS NOT NULL;

COMMENT ON COLUMN stickers.is_example IS 'Показывать как пример стиля';
COMMENT ON COLUMN stickers.style_preset_id IS 'ID стиля (денормализация из sessions)';
```

### Запрос примеров

```sql
SELECT telegram_file_id
FROM stickers
WHERE style_preset_id = :styleId
  AND is_example = true
  AND telegram_file_id IS NOT NULL
ORDER BY created_at DESC
LIMIT 3
OFFSET :offset;
```

## Локализация

| Ключ | RU | EN |
|------|----|----|
| btn.example | Пример | Example |
| btn.more_example | Ещё | More |
| btn.back_to_styles | ← Назад | ← Back |
| example.caption | Пример стиля {style} | {style} style example |
| example.no_more | Больше примеров нет | No more examples |
| example.not_available | Примеров пока нет | No examples yet |
| btn.make_example | Сделать примером | Make example |
| alert.made_example | ✅ Добавлен в примеры | ✅ Added to examples |

## Callback Data

| Callback | Действие |
|----------|----------|
| `style_example:{styleId}` | Показать первый пример |
| `style_example_more:{styleId}:{offset}` | Показать следующий пример |
| `back_to_styles` | Вернуться к выбору стиля |
| `make_example:{stickerId}` | Пометить стикер как пример |

## Реализация

### 1. Миграция БД

Создать `sql/034_style_examples.sql` и применить.

### 2. При создании стикера — сохранять style_preset_id

В `worker.ts` при сохранении стикера:

```typescript
await supabase.from("stickers").insert({
  // ... существующие поля
  style_preset_id: session.selected_style_id,  // NEW
});
```

### 3. Алерт "Новый стикер" с кнопкой

В `worker.ts` или `alerts.ts`:

```typescript
await sendNotification({
  type: "new_sticker",
  message: `👤 @${user.username}\n📦 Стиль: ${styleName}`,
  // ... images
  buttons: [[{
    text: "Сделать примером",
    callback_data: `make_example:${stickerId}`
  }]]
});
```

### 4. Handler для "Сделать примером"

В `index.ts`:

```typescript
bot.action(/^make_example:(.+)$/, async (ctx) => {
  const stickerId = ctx.match[1];
  
  await supabase
    .from("stickers")
    .update({ is_example: true })
    .eq("id", stickerId);
  
  await ctx.answerCbQuery("✅ Добавлен в примеры");
  
  // Опционально: обновить сообщение, убрать кнопку
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});
```

### 5. UI кнопок стилей

```typescript
// При формировании кнопок стилей
for (const preset of stylePresets) {
  const name = lang === "ru" ? preset.name_ru : preset.name_en;
  const exampleText = lang === "ru" ? "Пример" : "Example";
  
  buttons.push([
    Markup.button.callback(`${preset.emoji} ${name}`, `style:${preset.id}`),
    Markup.button.callback(exampleText, `style_example:${preset.id}`)
  ]);
}
```

### 6. Функция получения примеров

```typescript
const MAX_EXAMPLES = 3;

async function getStyleExample(styleId: string, offset: number) {
  if (offset >= MAX_EXAMPLES) return null;
  
  const { data } = await supabase
    .from("stickers")
    .select("telegram_file_id")
    .eq("style_preset_id", styleId)
    .eq("is_example", true)
    .not("telegram_file_id", "is", null)
    .order("created_at", { ascending: false })
    .range(offset, offset)
    .maybeSingle();
  
  return data?.telegram_file_id || null;
}

async function countStyleExamples(styleId: string) {
  const { count } = await supabase
    .from("stickers")
    .select("id", { count: "exact", head: true })
    .eq("style_preset_id", styleId)
    .eq("is_example", true)
    .not("telegram_file_id", "is", null);
  
  return Math.min(count || 0, MAX_EXAMPLES);
}
```

### 7. Handler для показа примера

```typescript
bot.action(/^style_example:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const styleId = ctx.match[1];
  const lang = /* получить язык */;
  
  const fileId = await getStyleExample(styleId, 0);
  
  if (!fileId) {
    const text = lang === "ru" ? "Примеров пока нет" : "No examples yet";
    await ctx.reply(text);
    return;
  }
  
  const styleName = /* получить название стиля */;
  const caption = lang === "ru" 
    ? `Пример стиля ${styleName}` 
    : `${styleName} style example`;
  
  await ctx.replyWithSticker(fileId);
  
  const totalExamples = await countStyleExamples(styleId);
  const buttons = [];
  
  if (totalExamples > 1) {
    buttons.push([Markup.button.callback(
      lang === "ru" ? "Ещё" : "More",
      `style_example_more:${styleId}:1`
    )]);
  }
  buttons.push([Markup.button.callback(
    lang === "ru" ? "← Назад" : "← Back",
    "back_to_styles"
  )]);
  
  await ctx.reply(caption, Markup.inlineKeyboard(buttons));
});
```

### 8. Handler для "Ещё"

```typescript
bot.action(/^style_example_more:(.+):(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const styleId = ctx.match[1];
  const offset = parseInt(ctx.match[2], 10);
  const lang = /* получить язык */;
  
  const fileId = await getStyleExample(styleId, offset);
  
  if (!fileId) {
    const text = lang === "ru" ? "Больше примеров нет" : "No more examples";
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback(lang === "ru" ? "← Назад" : "← Back", "back_to_styles")]
    ]));
    return;
  }
  
  await ctx.replyWithSticker(fileId);
  
  const buttons = [];
  const totalExamples = await countStyleExamples(styleId);
  
  if (offset + 1 < totalExamples) {
    buttons.push([Markup.button.callback(
      lang === "ru" ? "Ещё" : "More",
      `style_example_more:${styleId}:${offset + 1}`
    )]);
  }
  buttons.push([Markup.button.callback(
    lang === "ru" ? "← Назад" : "← Back",
    "back_to_styles"
  )]);
  
  await ctx.reply("", Markup.inlineKeyboard(buttons));
});
```

### 9. Handler для "Назад"

```typescript
bot.action("back_to_styles", async (ctx) => {
  safeAnswerCbQuery(ctx);
  // Показать меню выбора стилей
  // Нужно получить сессию и вызвать функцию показа стилей
});
```

## Чеклист

- [ ] Миграция `034_style_examples.sql`
- [ ] При сохранении стикера — записывать `style_preset_id`
- [ ] Кнопка "Сделать примером" в алерте нового стикера
- [ ] Handler `make_example:{stickerId}`
- [ ] Тексты локализации в `texts.ts`
- [ ] Кнопка "Пример" в UI выбора стилей
- [ ] Handler `style_example:{styleId}`
- [ ] Handler `style_example_more:{styleId}:{offset}`
- [ ] Handler `back_to_styles`
- [ ] Тестирование

## Приватность

⚠️ **Ручная модерация:** Админ несёт ответственность за выбор примеров. При жалобе пользователя — убрать `is_example = false`.

```sql
-- Убрать из примеров
UPDATE stickers SET is_example = false WHERE id = 'xxx';
```
