# Оценка стикеров (Sticker Rating)

## Цель

Собирать оценки качества генерации от пользователей для анализа и улучшения качества.

## Флоу

```
1. Пользователь генерирует стикер
2. Worker отправляет стикер + кнопки действий
3. Через 3-5 секунд отправляем сообщение с оценкой:
   
   "Как вам результат? Оцените от 1 до 5:"
   [⭐1] [⭐2] [⭐3] [⭐4] [⭐5]
   [💬 Написать о проблеме]
   
4. Пользователь нажимает оценку → сохраняем в базу
5. Благодарим: "Спасибо за оценку! 🙏"
```

## База данных

### Новая таблица `sticker_ratings`

```sql
CREATE TABLE sticker_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sticker_id uuid REFERENCES stickers(id),
  session_id uuid REFERENCES sessions(id),
  user_id uuid REFERENCES users(id),
  telegram_id bigint NOT NULL,
  
  -- Параметры генерации
  generation_type text,  -- 'style', 'emotion', 'motion', 'text'
  style_id text,         -- selected_style_id
  emotion_id text,       -- selected_emotion
  prompt_final text,     -- финальный промпт
  
  -- Оценка
  rating smallint CHECK (rating >= 1 AND rating <= 5),
  rated_at timestamptz,
  
  -- Метаданные
  message_id bigint,     -- ID сообщения с оценкой (для удаления/редактирования)
  chat_id bigint,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ratings_user ON sticker_ratings(user_id);
CREATE INDEX idx_ratings_style ON sticker_ratings(style_id) WHERE style_id IS NOT NULL;
CREATE INDEX idx_ratings_pending ON sticker_ratings(user_id) WHERE rating IS NULL;
```

## Реализация

### 1. Worker.ts — после отправки стикера

```typescript
// После успешной отправки стикера
// Создаём запись для оценки и отправляем сообщение

const { data: ratingRecord } = await supabase
  .from("sticker_ratings")
  .insert({
    sticker_id: stickerId,
    session_id: session.id,
    user_id: user.id,
    telegram_id: user.telegram_id,
    generation_type: session.generation_type,
    style_id: session.selected_style_id,
    emotion_id: session.selected_emotion,
    prompt_final: session.prompt_final,
  })
  .select("id")
  .single();

// Отправляем сообщение с оценкой через 3 сек
setTimeout(async () => {
  const ratingMsg = await bot.telegram.sendMessage(
    user.telegram_id,
    "Как вам результат? Оцените от 1 до 5:",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⭐ 1", callback_data: `rate:${ratingRecord.id}:1` },
            { text: "⭐ 2", callback_data: `rate:${ratingRecord.id}:2` },
            { text: "⭐ 3", callback_data: `rate:${ratingRecord.id}:3` },
            { text: "⭐ 4", callback_data: `rate:${ratingRecord.id}:4` },
            { text: "⭐ 5", callback_data: `rate:${ratingRecord.id}:5` },
          ],
          [
            { text: "💬 Написать о проблеме", url: `https://t.me/p2s_support_bot?start=issue_${stickerId}` }
          ]
        ]
      }
    }
  );
  
  // Сохраняем message_id для возможного удаления
  await supabase
    .from("sticker_ratings")
    .update({ message_id: ratingMsg.message_id, chat_id: user.telegram_id })
    .eq("id", ratingRecord.id);
}, 3000);
```

### 2. Index.ts — callback для оценки

```typescript
// Callback: rate:<rating_id>:<score>
bot.action(/^rate:(.+):(\d)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const ratingId = ctx.match[1];
  const score = parseInt(ctx.match[2]);
  
  const { error } = await supabase
    .from("sticker_ratings")
    .update({ 
      rating: score, 
      rated_at: new Date().toISOString() 
    })
    .eq("id", ratingId)
    .is("rating", null); // Только если ещё не оценено
  
  if (!error) {
    await ctx.editMessageText(`Спасибо за оценку! ${"⭐".repeat(score)} 🙏`);
  }
});
```

### 3. Support-bot.ts — обработка issue_*

```typescript
// Добавить Map для issues
const pendingIssues = new Map<number, string>(); // telegram_id -> sticker_id

// В /start handler добавить:
if (payload?.startsWith("issue_")) {
  const stickerId = payload.replace("issue_", "");
  pendingIssues.set(ctx.from.id, stickerId);
  
  await ctx.reply(
    "Опишите проблему или предложение по улучшению:\n\n" +
    "Что именно не понравилось в результате?"
  );
  return;
}

// В text handler добавить:
if (pendingIssues.has(telegramId)) {
  const stickerId = pendingIssues.get(telegramId)!;
  pendingIssues.delete(telegramId);
  
  // Сохраняем issue
  await supabase.from("sticker_issues").insert({
    sticker_id: stickerId,
    telegram_id: telegramId,
    username: ctx.from.username,
    issue_text: ctx.message.text,
  });
  
  // Алерт в Support Channel
  await sendIssueAlert(ctx.from, stickerId, ctx.message.text);
  
  await ctx.reply("Спасибо! Мы учтём ваш отзыв при улучшении бота 💜");
  return;
}
```

### 4. Дополнительная таблица для issues (опционально)

```sql
CREATE TABLE sticker_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sticker_id uuid REFERENCES stickers(id),
  telegram_id bigint NOT NULL,
  username text,
  issue_text text NOT NULL,
  created_at timestamptz DEFAULT now()
);
```

## Аналитика

### SQL: Средняя оценка по стилям

```sql
SELECT 
  style_id,
  COUNT(*) as total,
  ROUND(AVG(rating), 2) as avg_rating,
  COUNT(*) FILTER (WHERE rating >= 4) as good,
  COUNT(*) FILTER (WHERE rating <= 2) as bad
FROM sticker_ratings
WHERE rating IS NOT NULL
GROUP BY style_id
ORDER BY avg_rating DESC;
```

### SQL: Оценки за последние 7 дней

```sql
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total,
  ROUND(AVG(rating), 2) as avg_rating
FROM sticker_ratings
WHERE rating IS NOT NULL
AND created_at > now() - interval '7 days'
GROUP BY DATE(created_at)
ORDER BY date;
```

### SQL: Проблемные генерации (низкие оценки)

```sql
SELECT 
  sr.id,
  sr.style_id,
  sr.emotion_id,
  sr.rating,
  sr.prompt_final,
  sr.created_at
FROM sticker_ratings sr
WHERE sr.rating <= 2
ORDER BY sr.created_at DESC
LIMIT 20;
```

## Опции (на будущее)

1. **Не спрашивать каждый раз** — показывать оценку только для каждого N-го стикера
2. **Автоудаление** — удалять сообщение с оценкой через 1 минуту если не ответили
3. **Алерт на низкие оценки** — отправлять в канал при rating <= 2

## Изменения в файлах

| Файл | Изменения |
|------|-----------|
| `sql/026_sticker_ratings.sql` | Новая таблица sticker_ratings |
| `sql/027_sticker_issues.sql` | Новая таблица sticker_issues (опц.) |
| `src/worker.ts` | Создание rating + отправка сообщения |
| `src/index.ts` | Callback `rate:*` |
| `src/support-bot.ts` | Обработка `issue_*` |

## Checklist

- [ ] SQL миграция `sticker_ratings`
- [ ] SQL миграция `sticker_issues` (опционально)
- [ ] Worker: создание записи + отправка сообщения
- [ ] Index: callback для оценки
- [ ] Support-bot: обработка issue_*
- [ ] Тексты локализации (ru/en)
- [ ] Деплой
- [ ] Тестирование
