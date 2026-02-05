# Feedback Survey (отдельный Support бот)

## Цель
Понять причины отказа от покупки через свободный текстовый опрос, не затрагивая основной флоу.

## Архитектура

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  photo2sticker  │     │     Worker      │     │  p2s_support    │
│   (основной)    │     │                 │     │   (feedback)    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │              UPDATE feedback_trigger_at       │
         │                       │                       │
         │                       └───────────────────────┤
         │                                               │
         │                              cron: отправка вопросов
         │                              text: приём ответов
         │                              reply: ответы админа
         │                                               │
         │                                    ┌──────────▼──────────┐
         │                                    │   Support Channel   │
         │                                    └─────────────────────┘
```

## Каналы

| Канал | Назначение |
|-------|------------|
| **Alert Channel** | Ошибки, технические алерты, бизнес-нотификации |
| **Support Channel** | Фидбек пользователей, диалоги |

## Триггер

**Условия:**
1. Пользователь завершил бесплатную генерацию (первый стикер)
2. Прошло **15 минут**
3. Баланс = **0 кредитов**
4. Опрос **ещё не отправлялся**

## Вопрос (от p2s_support бота)

```
👋 Привет! Вы попробовали создать стикер в @photo2sticker_bot.

Понравился результат? Что помешало продолжить?

Напишите пару слов — мы читаем каждый ответ 🙏
```

## Алерт при получении ответа (Support Channel)

```
📝 Фидбек

👤 @ivan (42269230)
💬 "дорого, хотелось бы дешевле"

[📩 Ответить]
```

Кнопка → `https://t.me/p2s_support_bot?start=reply_42269230`

## База данных

### Таблица `notification_triggers` (универсальная)

```sql
CREATE TABLE notification_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  telegram_id bigint NOT NULL,
  trigger_type text NOT NULL,  -- 'feedback_zero_credits', 'inactive_7d', etc.
  trigger_at timestamptz DEFAULT now(),
  fire_after timestamptz NOT NULL,  -- когда отправить (trigger_at + delay)
  fired_at timestamptz,  -- когда реально отправили
  status text DEFAULT 'pending',  -- pending, fired, cancelled
  metadata jsonb,  -- доп. данные
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_triggers_pending 
ON notification_triggers(fire_after) 
WHERE status = 'pending';

CREATE UNIQUE INDEX idx_triggers_unique_pending
ON notification_triggers(user_id, trigger_type)
WHERE status = 'pending';
```

### Таблица `user_feedback` (ответы)

```sql
CREATE TABLE user_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) UNIQUE,
  telegram_id bigint NOT NULL,
  username text,
  question_sent_at timestamptz DEFAULT now(),
  answer_text text,
  answer_at timestamptz,
  admin_reply_text text,
  admin_reply_at timestamptz,
  created_at timestamptz DEFAULT now()
);
```

### Типы триггеров

| trigger_type | Описание | Delay |
|--------------|----------|-------|
| `feedback_zero_credits` | Фидбек после бесплатной генерации | 15 мин |
| `inactive_7d` | Неактивный пользователь | 7 дней |
| (будущие) | ... | ... |

## Переменные окружения

```env
# Существующие
ALERT_CHANNEL_ID=-100xxx      # ошибки, технические алерты

# Новые
SUPPORT_BOT_TOKEN=xxx         # токен @p2s_support_bot
SUPPORT_CHANNEL_ID=-100yyy    # фидбек, диалоги с пользователями
```

## Реализация

### 1. worker.ts — установка триггера

```typescript
// После успешной отправки стикера, fire-and-forget
if (user.credits === 0) {
  const fireAfter = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // +15 min
  
  supabase.from("notification_triggers")
    .upsert({
      user_id: user.id,
      telegram_id: user.telegram_id,
      trigger_type: "feedback_zero_credits",
      fire_after: fireAfter,
      status: "pending",
    }, { onConflict: "user_id,trigger_type", ignoreDuplicates: true })
    .then(() => console.log("Feedback trigger created"))
    .catch(console.error);
}
```

**Изменения в основном флоу:** минимальные (1 UPSERT без await)

### 2. support-bot.ts — новый файл

```typescript
import { Telegraf } from "telegraf";
import { supabase } from "./lib/supabase";
import { config } from "./config";

const bot = new Telegraf(config.supportBotToken);
const ADMIN_IDS = [42269230]; // telegram_id админов

// Состояние reply в памяти
const pendingReplies = new Map<number, number>(); // admin_id -> target_user_id

// /start handler
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  
  // Админ хочет ответить
  if (payload?.startsWith("reply_") && ADMIN_IDS.includes(ctx.from.id)) {
    const targetId = parseInt(payload.replace("reply_", ""));
    pendingReplies.set(ctx.from.id, targetId);
    
    const { data: feedback } = await supabase
      .from("user_feedback")
      .select("username, answer_text")
      .eq("telegram_id", targetId)
      .maybeSingle();
    
    await ctx.reply(
      `Отвечаете пользователю @${feedback?.username || targetId}\n` +
      `Его ответ: "${feedback?.answer_text}"\n\n` +
      `Напишите ваш ответ:`
    );
    return;
  }
  
  await ctx.reply("Это бот поддержки photo2sticker. Ожидайте сообщений от нас!");
});

// Text handler
bot.on("text", async (ctx) => {
  const oderId = ctx.from.id;
  
  // Админ отвечает пользователю
  if (ADMIN_IDS.includes(userId) && pendingReplies.has(userId)) {
    const targetId = pendingReplies.get(userId)!;
    pendingReplies.delete(userId);
    
    await bot.telegram.sendMessage(targetId, ctx.message.text);
    
    await supabase.from("user_feedback")
      .update({ 
        admin_reply_text: ctx.message.text,
        admin_reply_at: new Date().toISOString()
      })
      .eq("telegram_id", targetId);
    
    // Уведомление в Support Channel
    await sendToSupportChannel(
      `✅ *Ответ отправлен*\n\n` +
      `👤 Кому: @${ctx.from.username || targetId} (${targetId})\n` +
      `💬 "${ctx.message.text}"`
    );
    
    await ctx.reply("✅ Ответ отправлен!");
    return;
  }
  
  // Пользователь отвечает на feedback
  const { data: feedback } = await supabase
    .from("user_feedback")
    .select("*")
    .eq("telegram_id", userId)
    .is("answer_text", null)
    .maybeSingle();
  
  if (feedback) {
    await supabase.from("user_feedback")
      .update({ 
        answer_text: ctx.message.text,
        answer_at: new Date().toISOString()
      })
      .eq("id", feedback.id);
    
    // Отправляем алерт в Support Channel
    await sendFeedbackAlert(ctx.from, ctx.message.text);
    
    await ctx.reply("Спасибо за ответ! 🙏");
    return;
  }
  
  await ctx.reply("Спасибо за сообщение! Мы свяжемся с вами если потребуется.");
});

// Cron: обработка триггеров (каждую минуту)
async function processTriggers() {
  const { data: triggers } = await supabase
    .from("notification_triggers")
    .select("*, users(username)")
    .eq("status", "pending")
    .eq("trigger_type", "feedback_zero_credits")
    .lte("fire_after", new Date().toISOString())
    .limit(10);
  
  if (!triggers?.length) return;
  
  console.log(`Processing ${triggers.length} feedback triggers`);
  
  for (const trigger of triggers) {
    try {
      await bot.telegram.sendMessage(trigger.telegram_id,
        "👋 Привет! Вы попробовали создать стикер в @photo2sticker_bot.\n\n" +
        "Понравился результат? Что помешало продолжить?\n\n" +
        "Напишите пару слов — мы читаем каждый ответ 🙏"
      );
      
      // Обновляем триггер как выполненный
      await supabase.from("notification_triggers")
        .update({ status: "fired", fired_at: new Date().toISOString() })
        .eq("id", trigger.id);
      
      // Создаём запись feedback
      await supabase.from("user_feedback").insert({
        user_id: trigger.user_id,
        telegram_id: trigger.telegram_id,
        username: trigger.users?.username,
      });
      
      console.log(`Feedback sent to ${trigger.telegram_id}`);
    } catch (err: any) {
      console.error(`Failed to send feedback to ${trigger.telegram_id}:`, err.message);
      
      // Если заблокировал бота — отменяем триггер
      if (err.response?.error_code === 403) {
        await supabase.from("notification_triggers")
          .update({ status: "cancelled", metadata: { error: "blocked" } })
          .eq("id", trigger.id);
      }
    }
  }
}

// Отправка в Support Channel
async function sendToSupportChannel(text: string) {
  const channelId = config.supportChannelId;
  if (!channelId) return;
  
  await fetch(`https://api.telegram.org/bot${config.supportBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      text,
      parse_mode: "Markdown",
    })
  });
}

// Алерт с кнопкой ответа
async function sendFeedbackAlert(from: any, text: string) {
  const channelId = config.supportChannelId;
  if (!channelId) return;
  
  const message = 
    `📝 *Фидбек*\n\n` +
    `👤 @${from.username || from.id} (${from.id})\n` +
    `💬 "${text}"`;
  
  await fetch(`https://api.telegram.org/bot${config.supportBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      text: message,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "📩 Ответить", url: `https://t.me/p2s_support_bot?start=reply_${from.id}` }
        ]]
      }
    })
  });
}

// Запуск
bot.launch().then(() => {
  console.log("Support bot started");
  processTriggers();
  setInterval(processTriggers, 60 * 1000);
});
```

### 3. config.ts — добавить токены

```typescript
export const config = {
  // ...existing
  supportBotToken: process.env.SUPPORT_BOT_TOKEN || "",
  supportChannelId: process.env.SUPPORT_CHANNEL_ID || "",
};
```

## Изменения в основном коде

| Файл | Изменение | Риск |
|------|-----------|------|
| worker.ts | +5 строк (UPDATE trigger) | ✅ Нулевой |
| config.ts | +2 строки | ✅ Нулевой |
| index.ts | ❌ Без изменений | ✅ Нулевой |

## Checklist

- [x] Создать бота @p2s_support_bot в BotFather
- [x] Создать канал "P2S Support"
- [x] Добавить @p2s_support_bot как админа в канал
- [x] Добавить SUPPORT_BOT_TOKEN в env
- [x] Добавить SUPPORT_CHANNEL_ID в env
- [x] Добавить ADMIN_IDS в env (твой telegram_id)
- [x] SQL миграция user_feedback → `sql/022_feedback.sql`
- [ ] SQL миграция notification_triggers → `sql/024_notification_triggers.sql`
- [ ] Обновить worker.ts (использовать notification_triggers)
- [ ] Обновить support-bot.ts (использовать notification_triggers)
- [x] Обновить config.ts
- [x] Создать Dockerfile.support
- [x] Деплой support бота
- [ ] Тестирование
