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

### Миграция

```sql
-- Поле для триггера в users
ALTER TABLE users ADD COLUMN feedback_trigger_at timestamptz;

-- Таблица feedback
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

-- Индекс для cron-запроса
CREATE INDEX users_feedback_trigger_idx 
  ON users(feedback_trigger_at) 
  WHERE feedback_trigger_at IS NOT NULL;
```

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
if (user.credits === 0 && !user.feedback_trigger_at) {
  supabase.from("users")
    .update({ feedback_trigger_at: new Date().toISOString() })
    .eq("id", user.id)
    .then(() => console.log("Feedback trigger set"))
    .catch(console.error);
}
```

**Изменения в основном флоу:** минимальные (1 UPDATE без await)

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

// Cron: отправка вопросов (каждую минуту)
async function sendFeedbackQuestions() {
  const { data: users } = await supabase
    .from("users")
    .select("id, telegram_id, username, feedback_trigger_at, credits")
    .not("feedback_trigger_at", "is", null)
    .lt("feedback_trigger_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .eq("credits", 0)
    .limit(10);
  
  if (!users?.length) return;
  
  for (const user of users) {
    // Проверяем что feedback ещё не отправлялся
    const { data: existing } = await supabase
      .from("user_feedback")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    
    if (existing) continue;
    
    try {
      await bot.telegram.sendMessage(user.telegram_id,
        "👋 Привет! Вы попробовали создать стикер в @photo2sticker_bot.\n\n" +
        "Понравился результат? Что помешало продолжить?\n\n" +
        "Напишите пару слов — мы читаем каждый ответ 🙏"
      );
      
      await supabase.from("user_feedback").insert({
        user_id: user.id,
        telegram_id: user.telegram_id,
        username: user.username,
      });
      
      console.log(`Feedback question sent to ${user.telegram_id}`);
    } catch (err) {
      console.error(`Failed to send feedback to ${user.telegram_id}:`, err);
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
bot.launch();
setInterval(sendFeedbackQuestions, 60 * 1000);

console.log("Support bot started");
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

- [ ] Создать бота @p2s_support_bot в BotFather
- [ ] Создать канал "P2S Support"
- [ ] Добавить @p2s_support_bot как админа в канал
- [ ] Добавить SUPPORT_BOT_TOKEN в env
- [ ] Добавить SUPPORT_CHANNEL_ID в env
- [ ] Добавить ADMIN_IDS в env (твой telegram_id)
- [x] SQL миграция (feedback_trigger_at + user_feedback) → `sql/022_feedback.sql`
- [x] Обновить worker.ts (установка триггера)
- [x] Создать support-bot.ts
- [x] Обновить config.ts
- [x] Создать Dockerfile.support
- [ ] Деплой support бота
- [ ] Тестирование
