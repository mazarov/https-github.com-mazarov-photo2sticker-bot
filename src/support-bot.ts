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

// Map для отслеживания кто ожидает ввода feedback
const pendingFeedback = new Map<number, string>(); // telegram_id -> user_id

// Map для отслеживания кто ожидает ввода issue
const pendingIssues = new Map<number, string>(); // telegram_id -> sticker_id

// Map для отслеживания ожидающих ответов на outreach
const pendingOutreach = new Map<number, string>(); // telegram_id -> outreach_id

console.log("Admin IDs:", ADMIN_IDS);

// /start handler
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  
  // Пользователь пришёл оставить feedback (из кнопки в основном боте)
  if (payload?.startsWith("feedback_")) {
    const userId = payload.replace("feedback_", "");
    pendingFeedback.set(ctx.from.id, userId);
    
    await ctx.reply(
      "Спасибо что решили оставить отзыв! 🙏\n\n" +
      "Напишите пару слов — что понравилось, что не понравилось, чего не хватает?"
    );
    return;
  }
  
  // Пользователь пришёл сообщить о проблеме со стикером
  if (payload?.startsWith("issue_")) {
    const stickerId = payload.replace("issue_", "");
    pendingIssues.set(ctx.from.id, stickerId);
    
    await ctx.reply(
      "Опишите проблему или предложение по улучшению:\n\n" +
      "Что именно не понравилось в результате?"
    );
    return;
  }
  
  // Пользователь пришёл ответить на outreach
  if (payload?.startsWith("outreach_")) {
    const outreachId = payload.replace("outreach_", "");
    
    // Verify outreach exists and is sent
    const { data: outreach } = await supabase
      .from("user_outreach")
      .select("id, status")
      .eq("id", outreachId)
      .single();
    
    if (outreach && (outreach.status === "sent" || outreach.status === "draft")) {
      pendingOutreach.set(ctx.from.id, outreachId);
      
      // Get localized prompt
      const { data: user } = await supabase
        .from("users")
        .select("lang")
        .eq("telegram_id", ctx.from.id)
        .maybeSingle();
      const lang = user?.lang || "en";
      
      const { data: textRow } = await supabase
        .from("bot_texts_new")
        .select("text")
        .eq("lang", lang)
        .eq("key", "outreach.reply_prompt")
        .maybeSingle();
      
      await ctx.reply(textRow?.text || "Thanks for replying! Write your thoughts — we will definitely read them 🙏");
    } else {
      await ctx.reply("Это бот поддержки photo2sticker. Напишите ваш вопрос!");
    }
    return;
  }
  
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
  
  await ctx.reply("Это бот поддержки photo2sticker. Напишите ваш вопрос!");
});

// Text handler
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  
  // Админ отвечает пользователю
  if (ADMIN_IDS.includes(telegramId) && pendingReplies.has(telegramId)) {
    const targetId = pendingReplies.get(telegramId)!;
    pendingReplies.delete(telegramId);
    
    try {
      // Send via MAIN bot (not support bot) — user may not have started support bot
      const mainBotToken = config.telegramBotToken;
      const res = await fetch(`https://api.telegram.org/bot${mainBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: targetId, text: ctx.message.text }),
      });
      const data = await res.json() as any;
      if (!data.ok) {
        throw new Error(data.description || "Unknown Telegram error");
      }
      
      await supabase.from("user_feedback")
        .update({ 
          admin_reply_text: ctx.message.text,
          admin_reply_at: new Date().toISOString()
        })
        .eq("telegram_id", targetId);
      
      // Уведомление в Support Channel
      await sendToSupportChannel(
        `✅ *Ответ отправлен* (через основной бот)\n\n` +
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
  
  // Пользователь отвечает на outreach
  if (pendingOutreach.has(telegramId)) {
    const outreachId = pendingOutreach.get(telegramId)!;
    pendingOutreach.delete(telegramId);
    
    // Save reply to DB
    await supabase
      .from("user_outreach")
      .update({
        reply_text: ctx.message.text,
        status: "replied",
        replied_at: new Date().toISOString(),
      })
      .eq("id", outreachId);
    
    // Load outreach for context
    const { data: outreach } = await supabase
      .from("user_outreach")
      .select("message_text, telegram_id")
      .eq("id", outreachId)
      .single();
    
    // Forward reply to alert channel via main bot
    const alertChannelId = config.alertChannelId;
    if (alertChannelId && outreach) {
      const alertText =
        `💬 *Ответ на outreach*\n\n` +
        `👤 @${escapeMarkdown(ctx.from.username || String(ctx.from.id))} (${ctx.from.id})\n` +
        `📨 Было: "${escapeMarkdown((outreach.message_text || "").slice(0, 200))}"\n` +
        `💬 Ответ: "${escapeMarkdown(ctx.message.text)}"`;
      
      try {
        await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: alertChannelId,
            text: alertText,
            parse_mode: "Markdown",
          }),
        });
      } catch (err) {
        console.error("[Outreach] Failed to forward reply to alert channel:", err);
      }
    }
    
    // Thank the user
    const { data: user } = await supabase
      .from("users")
      .select("lang")
      .eq("telegram_id", telegramId)
      .maybeSingle();
    const lang = user?.lang || "en";
    
    const { data: thanksRow } = await supabase
      .from("bot_texts_new")
      .select("text")
      .eq("lang", lang)
      .eq("key", "outreach.reply_thanks")
      .maybeSingle();
    
    await ctx.reply(thanksRow?.text || "Thank you for your feedback! We really appreciate it 🙏");
    return;
  }
  
  // Пользователь оставляет feedback (пришёл по кнопке из основного бота)
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
  
  // Пользователь сообщает о проблеме со стикером
  if (pendingIssues.has(telegramId)) {
    const stickerId = pendingIssues.get(telegramId)!;
    pendingIssues.delete(telegramId);
    
    // Сохраняем в базу
    await supabase.from("sticker_issues").insert({
      sticker_id: stickerId,
      telegram_id: telegramId,
      username: ctx.from.username,
      issue_text: ctx.message.text,
    });
    
    // Отправляем алерт в Support Channel
    await sendIssueAlert(ctx.from, stickerId, ctx.message.text);
    
    await ctx.reply("Спасибо! Мы учтём ваш отзыв при улучшении бота 💜");
    return;
  }
  
  // Пользователь отвечает на feedback (старый флоу - для совместимости)
  const { data: feedback } = await supabase
    .from("user_feedback")
    .select("*")
    .eq("telegram_id", telegramId)
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

// Алерт о проблеме со стикером
async function sendIssueAlert(from: any, stickerId: string, text: string) {
  const channelId = config.supportChannelId;
  if (!channelId) return;
  
  const message = 
    `🐛 *Проблема со стикером*\n\n` +
    `👤 @${from.username || from.id} (${from.id})\n` +
    `🎨 Стикер: \`${stickerId}\`\n` +
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
    console.error("Failed to send issue alert:", err);
  }
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
console.log("Starting bot.launch()...");
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log("Support bot started");
}).catch((err) => {
  console.error("Failed to start support bot:", err);
  process.exit(1);
});
