# Исправление «Добавить в пак» — Требования

## Проблема

Кнопка «Добавить в пак» не работает, если:
- Пользователь начал новую генерацию (отправил фото)
- Пользователь нажал /start
- Действие на другом устройстве создало новую сессию

Причина: `add_to_pack` ищет **активную сессию**, а она уже сменилась и `last_sticker_file_id = null`.

---

## Решение — Привязка к сообщению

Передавать **ID стикера** в `callback_data` кнопки.  
При нажатии — доставать стикер напрямую из БД по ID, а не искать активную сессию.

---

## Текущая логика

### worker.ts — отправка стикера

```typescript
const replyMarkup = {
  inline_keyboard: [
    [{ text: "➕ Добавить в пак", callback_data: "add_to_pack" }],
    // ...
  ],
};
```

### index.ts — обработка

```typescript
bot.action("add_to_pack", async (ctx) => {
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    // ❌ Ошибка: "Вы не добавили ни одного стикера"
  }
});
```

---

## Новая логика

### 1. Сохранять sticker в БД и получать ID

После `sendSticker` сохраняем в таблицу `stickers` и получаем `id`:

```typescript
const { data: stickerRecord } = await supabase
  .from("stickers")
  .insert({
    user_id: session.user_id,
    // ...
    telegram_file_id: stickerFileId, // <-- добавить поле
  })
  .select("id")
  .single();
```

### 2. Передавать sticker_id в callback_data

```typescript
const replyMarkup = {
  inline_keyboard: [
    [{ text: "➕ Добавить в пак", callback_data: `add_to_pack:${stickerRecord.id}` }],
    [
      { text: "🎨 Изменить стиль", callback_data: `change_style:${stickerRecord.id}` },
      { text: "😊 Изменить эмоцию", callback_data: `change_emotion:${stickerRecord.id}` },
    ],
  ],
};
```

**Примечание:** UUID = 36 символов, callback_data лимит = 64 байта — помещается.

### 3. Обработчик add_to_pack по ID

```typescript
bot.action(/^add_to_pack:(.+)$/, async (ctx) => {
  const stickerId = ctx.match[1];
  
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();
  
  if (!sticker?.telegram_file_id) {
    await ctx.reply("Стикер не найден");
    return;
  }
  
  // Проверяем, что стикер принадлежит пользователю
  if (sticker.user_id !== user.id) {
    return;
  }
  
  // Добавляем в пак по telegram_file_id
  // ...
});
```

### 4. Обработчики change_style / change_emotion

Аналогично — получать `session_id` или `source_photo_file_id` из записи стикера:

```typescript
bot.action(/^change_style:(.+)$/, async (ctx) => {
  const stickerId = ctx.match[1];
  
  const { data: sticker } = await supabase
    .from("stickers")
    .select("session_id, source_photo_file_id")
    .eq("id", stickerId)
    .maybeSingle();
  
  // Использовать source_photo_file_id для новой генерации
});
```

---

## Изменения в БД

### Таблица stickers — добавить поле

```sql
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS telegram_file_id text;
```

---

## SQL миграция

```sql
-- 012_sticker_file_id.sql
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS telegram_file_id text;
```

---

## Изменения в коде

### worker.ts

1. Сначала отправить стикер → получить `stickerFileId`
2. Сохранить в `stickers` с `telegram_file_id`
3. Получить `sticker.id`
4. Использовать `sticker.id` в callback_data кнопок

### index.ts

1. Изменить `bot.action("add_to_pack", ...)` на `bot.action(/^add_to_pack:(.+)$/, ...)`
2. Доставать стикер по ID из `stickers`
3. Использовать `telegram_file_id` для добавления в пак
4. Аналогично для `change_style`, `change_emotion`

---

## Обратная совместимость

Оставить fallback на старый `add_to_pack` (без ID) для старых сообщений:

```typescript
// Новый формат
bot.action(/^add_to_pack:(.+)$/, async (ctx) => { ... });

// Старый формат (fallback)
bot.action("add_to_pack", async (ctx) => {
  // Старая логика через getActiveSession
});
```

---

## Ожидаемый результат

| Сценарий | До | После |
|----------|-----|-------|
| Нажать после /start | ❌ Ошибка | ✅ Работает |
| Нажать с другого устройства | ❌ Ошибка | ✅ Работает |
| Нажать во время генерации | ❌ Ошибка | ✅ Работает |
| Старые сообщения без ID | ❌ Ошибка | ⚠️ Fallback |

---

## Чеклист

- [x] Добавить поле `telegram_file_id` в `stickers`
- [x] SQL миграция `012_sticker_file_id.sql`
- [x] worker.ts: сохранять `telegram_file_id`, использовать `sticker.id` в кнопках
- [x] index.ts: новый обработчик `add_to_pack:ID`
- [x] index.ts: новые обработчики `change_style:ID`, `change_emotion:ID`
- [x] Fallback для старых сообщений
- [ ] Тестирование между устройствами
