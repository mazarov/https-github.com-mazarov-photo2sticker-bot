import { Telegraf } from "telegraf";
import { supabase } from "./lib/supabase";
import { config } from "./config";

if (!config.supportBotToken) {
  console.error("SUPPORT_BOT_TOKEN is not set, exiting");
  process.exit(1);
}

const bot = new Telegraf(config.supportBotToken);
const ADMIN_IDS = config.adminIds;

// Состояние reply в памяти
const pendingReplies = new Map<number, number>(); // admin_id -> target_user_id

console.log("Admin IDs:", ADMIN_IDS);

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
      `Его ответ: "${feedback?.answer_text || "нет ответа"}"\n\n` +
      `Напишите ваш ответ:`
    );
    return;
  }
  
  await ctx.reply("Это бот поддержки photo2sticker. Ожидайте сообщений от нас!");
});

// Text handler
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  
  // Админ отвечает пользователю
  if (ADMIN_IDS.includes(userId) && pendingReplies.has(userId)) {
    const targetId = pendingReplies.get(userId)!;
    pendingReplies.delete(userId);
    
    try {
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
        `👤 Кому: ${targetId}\n` +
        `💬 "${escapeMarkdown(ctx.message.text)}"`
      );
      
      await ctx.reply("✅ Ответ отправлен!");
    } catch (err: any) {
      console.error("Failed to send reply:", err);
      await ctx.reply(`❌ Ошибка отправки: ${err.message}`);
    }
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
  
  // Произвольное сообщение - тоже уведомляем с кнопкой ответа
  await sendMessageAlert(ctx.from, ctx.message.text);
  
  await ctx.reply("Спасибо за сообщение! Мы свяжемся с вами если потребуется.");
});

// Cron: обработка триггеров (каждую минуту)
async function processTriggers() {
  try {
    const now = new Date().toISOString();
    
    const { data: triggers, error } = await supabase
      .from("notification_triggers")
      .select("*, users(username)")
      .eq("status", "pending")
      .eq("trigger_type", "feedback_zero_credits")
      .lte("fire_after", now)
      .limit(10);
    
    if (error) {
      console.error("Error fetching triggers:", error);
      return;
    }
    
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
          username: (trigger as any).users?.username,
        });
        
        console.log(`Feedback sent to ${trigger.telegram_id}`);
      } catch (err: any) {
        console.error(`Failed to send feedback to ${trigger.telegram_id}:`, err.message);
        
        // Если пользователь заблокировал бота — отменяем триггер
        if (err.response?.error_code === 403) {
          await supabase.from("notification_triggers")
            .update({ status: "cancelled", metadata: { error: "blocked" } })
            .eq("id", trigger.id);
        }
      }
    }
  } catch (err) {
    console.error("Error in processTriggers:", err);
  }
}

// Отправка в Support Channel
async function sendToSupportChannel(text: string) {
  const channelId = config.supportChannelId;
  if (!channelId) {
    console.log("SUPPORT_CHANNEL_ID not set, skipping");
    return;
  }
  
  try {
    await fetch(`https://api.telegram.org/bot${config.supportBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text,
        parse_mode: "Markdown",
      })
    });
  } catch (err) {
    console.error("Failed to send to support channel:", err);
  }
}

// Алерт с кнопкой ответа (для фидбека)
async function sendFeedbackAlert(from: any, text: string) {
  await sendAlertWithReply(from, text, "📝 *Фидбек*");
}

// Алерт с кнопкой ответа (для произвольного сообщения)
async function sendMessageAlert(from: any, text: string) {
  await sendAlertWithReply(from, text, "💬 *Сообщение*");
}

// Общая функция для алертов с кнопкой ответа
async function sendAlertWithReply(from: any, text: string, title: string) {
  const channelId = config.supportChannelId;
  if (!channelId) return;
  
  const message = 
    `${title}\n\n` +
    `👤 @${from.username || from.id} (${from.id})\n` +
    `💬 "${escapeMarkdown(text)}"`;
  
  try {
    await fetch(`https://api.telegram.org/bot${config.supportBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text: message,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "📩 Ответить", url: `https://t.me/${config.supportBotUsername}?start=reply_${from.id}` }
          ]]
        }
      })
    });
  } catch (err) {
    console.error("Failed to send feedback alert:", err);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[\]]/g, "\\$&");
}

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// Запуск
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log("Support bot started");
  
  // Запускаем cron сразу и каждую минуту
  processTriggers();
  setInterval(processTriggers, 60 * 1000);
}).catch((err) => {
  console.error("Failed to start support bot:", err);
  process.exit(1);
});
