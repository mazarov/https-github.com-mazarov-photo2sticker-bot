# Feedback Survey v2 (гибридный подход)

## Проблема с текущей реализацией

Support бот не может инициировать диалог с пользователями, которые с ним не взаимодействовали.
Telegram API запрещает ботам писать первыми незнакомым пользователям.

## Новая архитектура

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  photo2sticker  │     │     Worker      │     │  p2s_support    │
│   (основной)    │     │                 │     │   (feedback)    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │              INSERT trigger                   │
         │              (credits = 0)                    │
         │                       │                       │
   cron: process triggers ◄──────┘                       │
   отправляет сообщение                                  │
   с кнопкой на support бот                              │
         │                                               │
         │     ───── пользователь нажал кнопку ─────►    │
         │                                               │
         │                              /start feedback_<user_id>
         │                              приём текста
         │                              сохранение в user_feedback
         │                              алерт в Support Channel
         │                                               │
         │                                    ┌──────────▼──────────┐
         │                                    │   Support Channel   │
         │                                    └─────────────────────┘
```

## Разделение ответственности

| Компонент | Задачи |
|-----------|--------|
| **Worker** | Создаёт триггер при credits = 0 |
| **Main Bot (index.ts)** | Cron: отправляет сообщение с кнопкой |
| **Support Bot** | Принимает текстовый feedback, пересылает админу |

## Сообщение от основного бота

```
У вас закончились бесплатные кредиты 😢

Расскажите, как вам бот? Ваш отзыв поможет нам стать лучше!

[✍️ Оставить отзыв]
```

Кнопка → `https://t.me/p2s_support_bot?start=feedback_<user_id>`

## Реализация

### 1. index.ts — cron для обработки триггеров

```typescript
// Cron: обработка feedback триггеров (каждую минуту)
async function processFeedbackTriggers() {
  try {
    const now = new Date().toISOString();
    const { data: triggers, error } = await supabase
      .from("notification_triggers")
      .select("*")
      .eq("status", "pending")
      .eq("trigger_type", "feedback_zero_credits")
      .lte("fire_after", now)
      .limit(10);

    if (error || !triggers?.length) return;

    console.log(`Processing ${triggers.length} feedback triggers`);

    for (const trigger of triggers) {
      try {
        await bot.telegram.sendMessage(
          trigger.telegram_id,
          "У вас закончились бесплатные кредиты 😢\n\n" +
          "Расскажите, как вам бот? Ваш отзыв поможет нам стать лучше!",
          {
            reply_markup: {
              inline_keyboard: [[
                { 
                  text: "✍️ Оставить отзыв", 
                  url: `https://t.me/p2s_support_bot?start=feedback_${trigger.user_id}` 
                }
              ]]
            }
          }
        );

        // Обновляем триггер как выполненный
        await supabase
          .from("notification_triggers")
          .update({ status: "fired", fired_at: now })
          .eq("id", trigger.id);

        console.log(`Feedback message sent to ${trigger.telegram_id}`);
      } catch (err: any) {
        console.error(`Failed to send feedback to ${trigger.telegram_id}:`, err.message);

        // Если заблокировал бота — отменяем триггер
        if (err.response?.error_code === 403) {
          await supabase
            .from("notification_triggers")
            .update({ status: "cancelled", metadata: { error: "blocked" } })
            .eq("id", trigger.id);
        }
      }
    }
  } catch (err) {
    console.error("Error in processFeedbackTriggers:", err);
  }
}

// Запуск cron после старта бота
// В конце файла, после bot.launch():
processFeedbackTriggers();
setInterval(processFeedbackTriggers, 60 * 1000);
```

### 2. support-bot.ts — обработка /start feedback_*

```typescript
// Map для отслеживания кто ожидает ввода feedback
const pendingFeedback = new Map<number, string>(); // telegram_id -> user_id

// Обновлённый /start handler
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  
  // Пользователь пришёл оставить feedback
  if (payload?.startsWith("feedback_")) {
    const userId = payload.replace("feedback_", "");
    pendingFeedback.set(ctx.from.id, userId);
    
    await ctx.reply(
      "Спасибо что решили оставить отзыв! 🙏\n\n" +
      "Напишите пару слов — что понравилось, что не понравилось, чего не хватает?"
    );
    return;
  }
  
  // Админ хочет ответить
  if (payload?.startsWith("reply_") && ADMIN_IDS.includes(ctx.from.id)) {
    // ... существующая логика ...
  }
  
  await ctx.reply("Это бот поддержки photo2sticker. Напишите ваш вопрос!");
});

// Обновлённый text handler
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  
  // Пользователь оставляет feedback
  if (pendingFeedback.has(telegramId)) {
    const userId = pendingFeedback.get(telegramId)!;
    pendingFeedback.delete(telegramId);
    
    // Сохраняем в базу
    await supabase.from("user_feedback").upsert({
      user_id: userId,
      telegram_id: telegramId,
      username: ctx.from.username,
      answer_text: ctx.message.text,
      answer_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    
    // Отправляем алерт в Support Channel
    await sendFeedbackAlert(ctx.from, ctx.message.text);
    
    await ctx.reply("Спасибо за отзыв! Мы обязательно его прочитаем 💜");
    return;
  }
  
  // ... остальная логика (admin reply, general message) ...
});
```

### 3. Убрать cron из support-bot.ts

Удалить `processTriggers()` и `setInterval(processTriggers, ...)` — 
теперь это делает основной бот.

Оставить только:
- Обработку `/start feedback_*` и `/start reply_*`
- Приём текстовых сообщений
- Fallback можно убрать

## Изменения в файлах

| Файл | Изменения |
|------|-----------|
| `src/index.ts` | +40 строк (функция processFeedbackTriggers + запуск cron) |
| `src/support-bot.ts` | Добавить pendingFeedback Map, обработку feedback_*, убрать старый cron |
| `worker.ts` | Без изменений (уже создаёт триггеры) |

## Преимущества

1. **Решает проблему** — основной бот может писать своим пользователям
2. **Чистое разделение** — main бот отправляет, support бот принимает текст
3. **Нет конфликтов** — текстовый ввод изолирован в support боте
4. **Пользователь сам решает** — нажимает кнопку только если хочет оставить отзыв

## Checklist

- [ ] Обновить `src/index.ts` — добавить processFeedbackTriggers cron
- [ ] Обновить `src/support-bot.ts` — добавить обработку feedback_*, убрать старый cron
- [ ] Отменить pending триггеры (SQL: UPDATE ... SET status = 'cancelled')
- [ ] Создать новые триггеры для всех users с credits = 0
- [ ] Деплой обоих ботов
- [ ] Тестирование полного флоу

## SQL: Сброс и пересоздание триггеров

```sql
-- Отменить все pending триггеры
UPDATE notification_triggers 
SET status = 'cancelled' 
WHERE trigger_type = 'feedback_zero_credits' 
AND status = 'pending';

-- Создать новые триггеры (после деплоя)
INSERT INTO notification_triggers (user_id, telegram_id, trigger_type, fire_after, status)
SELECT 
  u.id,
  u.telegram_id,
  'feedback_zero_credits',
  now() + (row_number() OVER () * interval '1 second'),
  'pending'
FROM users u
WHERE u.credits = 0
AND NOT EXISTS (
  SELECT 1 FROM notification_triggers nt 
  WHERE nt.user_id = u.id 
  AND nt.trigger_type = 'feedback_zero_credits'
  AND nt.status = 'fired'  -- только если ещё не отправляли
);
```
