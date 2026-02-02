import express from "express";
import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getText } from "./lib/texts";

const bot = new Telegraf(config.telegramBotToken);
const app = express();
app.use(express.json({ limit: "10mb" }));

// Cache for agent data (refreshed every 5 minutes)
let agentCache: { data: any; timestamp: number } | null = null;
const AGENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getAgent(name: string) {
  const now = Date.now();
  if (agentCache && agentCache.data?.name === name && now - agentCache.timestamp < AGENT_CACHE_TTL) {
    return agentCache.data;
  }

  const { data } = await supabase
    .from("agents")
    .select("*")
    .eq("name", name)
    .eq("is_active", true)
    .maybeSingle();

  if (data) {
    agentCache = { data, timestamp: now };
  }
  return data;
}

// Generate prompt using LLM
interface PromptResult {
  ok: boolean;
  prompt?: string | null;
  retry?: boolean;
}

async function generatePrompt(userInput: string): Promise<PromptResult> {
  try {
    const agent = await getAgent("prompt_generator");
    if (!agent) {
      console.error("Agent 'prompt_generator' not found in database");
      // Fallback: return user input as-is
      return { ok: true, prompt: userInput, retry: false };
    }

    const fewShotExamples = agent.few_shot_examples || [];
    
    // Build messages for Gemini
    const contents: any[] = [];
    
    // Add few-shot examples as conversation history
    for (const example of fewShotExamples) {
      contents.push({
        role: "user",
        parts: [{ text: example.human }],
      });
      contents.push({
        role: "model",
        parts: [{ text: example.ai }],
      });
    }
    
    // Add current user input
    contents.push({
      role: "user",
      parts: [{ text: userInput }],
    });

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${agent.model}:generateContent`,
      {
        systemInstruction: {
          parts: [{ text: agent.system_prompt }],
        },
        contents,
        generationConfig: {
          responseMimeType: "application/json",
        },
      },
      {
        headers: { "x-goog-api-key": config.geminiApiKey },
      }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("Gemini returned no text");
      return { ok: true, prompt: userInput, retry: false }; // Fallback
    }

    const parsed = JSON.parse(text);
    return {
      ok: parsed.ok === true,
      prompt: parsed.prompt,
      retry: parsed.retry === true,
    };
  } catch (err: any) {
    console.error("generatePrompt error:", err.response?.data || err.message);
    // Fallback: return user input as-is
    return { ok: true, prompt: userInput, retry: false };
  }
}

// Credit packages: { credits: price_in_stars }
const CREDIT_PACKS = [
  { credits: 2, price: 15 },
  { credits: 5, price: 30 },
  { credits: 10, price: 60 },
  { credits: 20, price: 100 },
];

// Helper: get user by telegram_id
async function getUser(telegramId: number) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  return data;
}

// Helper: get active session
async function getActiveSession(userId: string) {
  const { data } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  return data;
}

// Helper: send buy credits menu
async function sendBuyCreditsMenu(ctx: any, user: any, messageText?: string) {
  const lang = user.lang || "en";
  const text = messageText || await getText(lang, "payment.balance", { credits: user.credits });

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  for (let i = 0; i < CREDIT_PACKS.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    const left = CREDIT_PACKS[i];
    row.push(
      Markup.button.callback(
        `${left.credits} — ${left.price}⭐`,
        `pack_${left.credits}_${left.price}`
      )
    );

    const right = CREDIT_PACKS[i + 1];
    if (right) {
      row.push(
        Markup.button.callback(
          `${right.credits} — ${right.price}⭐`,
          `pack_${right.credits}_${right.price}`
        )
      );
    }

    buttons.push(row);
  }

  const cancelText = lang === "ru" ? "❌ Отмена" : "❌ Cancel";
  buttons.push([Markup.button.callback(cancelText, "cancel")]);

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

// /start command
bot.start(async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  let user = await getUser(telegramId);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru")
      ? "ru"
      : "en";

    const { data: created } = await supabase
      .from("users")
      .insert({ telegram_id: telegramId, lang, credits: 1 })
      .select("*")
      .single();

    user = created;

    // Create transaction for free credit
    if (user?.id) {
      await supabase.from("transactions").insert({
        user_id: user.id,
        amount: 1,
        price: 0,
        state: "done",
        is_active: false,
      });
    }
  }

  if (user?.id) {
    // Cancel all active sessions
    await supabase
      .from("sessions")
      .update({ state: "canceled", is_active: false })
      .eq("user_id", user.id)
      .eq("is_active", true);

    // Create new session
    await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_photo", is_active: true })
      .select();
  }

  const lang = user?.lang || "en";
  const greeting = isNewUser
    ? await getText(lang, "start.greeting_new")
    : await getText(lang, "start.greeting_return", { credits: user?.credits || 0 });

  await ctx.reply(greeting);
});

// Photo handler
bot.on("photo", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) {
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
  if (!photo) return;

  const photos = Array.isArray(session.photos) ? session.photos : [];
  photos.push(photo.file_id);

  await supabase
    .from("sessions")
    .update({ photos, state: "wait_description" })
    .eq("id", session.id);

  await ctx.reply(await getText(lang, "photo.ask_style"));
});

// Text handler (style description)
bot.on("text", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (ctx.message.text?.startsWith("/")) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) {
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  // Check if we're in wait_description state
  if (session.state !== "wait_description") {
    if (session.state === "wait_photo") {
      await ctx.reply(await getText(lang, "photo.need_photo"));
    }
    return;
  }

  const photosCount = Array.isArray(session.photos) ? session.photos.length : 0;
  if (photosCount === 0) {
    await ctx.reply(await getText(lang, "photo.need_photo"));
    return;
  }

  // Generate prompt using LLM
  await ctx.reply(await getText(lang, "photo.processing"));
  
  const promptResult = await generatePrompt(ctx.message.text);
  
  if (!promptResult.ok || promptResult.retry) {
    await ctx.reply(await getText(lang, "photo.invalid_style"));
    return;
  }

  const generatedPrompt = promptResult.prompt || ctx.message.text;

  const userInput = ctx.message.text;

  // Check credits
  if (user.credits < photosCount) {
    await supabase
      .from("sessions")
      .update({ state: "wait_buy_credit", user_input: userInput, prompt_final: generatedPrompt })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "photo.not_enough_credits", {
      needed: photosCount,
      balance: user.credits,
    }));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Deduct credits
  await supabase
    .from("users")
    .update({ credits: user.credits - photosCount })
    .eq("id", user.id);

  // Update session to processing with generated prompt and user input
  await supabase
    .from("sessions")
    .update({ user_input: userInput, prompt_final: generatedPrompt, state: "processing" })
    .eq("id", session.id);

  // Create job
  await supabase.from("jobs").insert({
    session_id: session.id,
    user_id: user.id,
    status: "queued",
    attempts: 0,
  });

  await ctx.reply(await getText(lang, "photo.generation_started"));
});

// Callback: buy_credits
bot.action("buy_credits", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) return;

  await sendBuyCreditsMenu(ctx, user);
});

// Callback: cancel
bot.action("cancel", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  const lang = user?.lang || "en";
  
  await ctx.answerCbQuery(lang === "ru" ? "Отменено" : "Canceled");
  await ctx.deleteMessage().catch(() => {});

  if (!user?.id) return;

  const session = await getActiveSession(user.id);
  if (session?.state === "wait_buy_credit") {
    await supabase
      .from("sessions")
      .update({ state: "wait_description" })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "payment.canceled"));
  }
});

// Callback: pack_N_PRICE (e.g., pack_5_30)
bot.action(/^pack_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const match = ctx.match;
  const credits = parseInt(match[1], 10);
  const price = parseInt(match[2], 10);

  // Validate pack
  const pack = CREDIT_PACKS.find((p) => p.credits === credits && p.price === price);
  if (!pack) {
    await ctx.reply(await getText(lang, "payment.invalid_pack"));
    return;
  }

  // Cancel old active transactions
  await supabase
    .from("transactions")
    .update({ state: "canceled", is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true);

  // Create new transaction
  const { data: transaction } = await supabase
    .from("transactions")
    .insert({
      user_id: user.id,
      amount: credits,
      price: price,
      state: "created",
      is_active: true,
    })
    .select("*")
    .single();

  if (!transaction) {
    await ctx.reply(await getText(lang, "payment.error_create"));
    return;
  }

  // Send invoice via Telegram Stars
  try {
    const invoicePayload = `[${transaction.id}]`;
    const title = lang === "ru" ? `${credits} кредитов` : `${credits} credits`;
    const description = lang === "ru" 
      ? `Пополнение баланса на ${credits} кредитов`
      : `Top up balance with ${credits} credits`;
    const label = lang === "ru" ? "Кредиты" : "Credits";

    await axios.post(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendInvoice`,
      {
        chat_id: telegramId,
        title,
        description,
        payload: invoicePayload,
        currency: "XTR",
        prices: [{ label, amount: price }],
      }
    );
  } catch (err: any) {
    console.error("sendInvoice error:", err.response?.data || err.message);
    await ctx.reply(await getText(lang, "payment.error_invoice"));
  }
});

// Pre-checkout query handler
bot.on("pre_checkout_query", async (ctx) => {
  const query = ctx.preCheckoutQuery;
  const invoicePayload = query.invoice_payload;

  // Extract transaction ID from payload like "[uuid]"
  const transactionId = invoicePayload.replace(/[\[\]]/g, "");

  // Atomic update: change state from "created" to "processed"
  const { data: updatedTransactions } = await supabase
    .from("transactions")
    .update({
      state: "processed",
      pre_checkout_query_id: query.id,
    })
    .eq("id", transactionId)
    .eq("state", "created")
    .select("*");

  if (!updatedTransactions?.length) {
    await ctx.answerPreCheckoutQuery(false, "Транзакция не найдена или уже обработана.");
    return;
  }

  // Answer OK
  await ctx.answerPreCheckoutQuery(true);
});

// Successful payment handler
bot.on("successful_payment", async (ctx) => {
  const payment = ctx.message.successful_payment;
  const invoicePayload = payment.invoice_payload;

  // Extract transaction ID
  const transactionId = invoicePayload.replace(/[\[\]]/g, "");

  // Atomic update: only one request can successfully change state from "processed" to "done"
  const { data: updatedTransactions } = await supabase
    .from("transactions")
    .update({
      state: "done",
      is_active: false,
      telegram_payment_charge_id: payment.telegram_payment_charge_id,
      provider_payment_charge_id: payment.provider_payment_charge_id,
    })
    .eq("id", transactionId)
    .eq("state", "processed")
    .select("*");

  const transaction = updatedTransactions?.[0];

  if (!transaction) {
    // Already processed or not found - this prevents double crediting
    console.log("Transaction already processed or not found:", transactionId);
    return;
  }

  // Get user and add credits
  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", transaction.user_id)
    .maybeSingle();

  if (user) {
    const lang = user.lang || "en";
    const newCredits = (user.credits || 0) + transaction.amount;
    await supabase
      .from("users")
      .update({ credits: newCredits })
      .eq("id", user.id);

    await ctx.reply(await getText(lang, "payment.success", {
      amount: transaction.amount,
      balance: newCredits,
    }));

    // Check if there's a pending session waiting for credits
    const session = await getActiveSession(user.id);
    if (session?.state === "wait_buy_credit" && session.prompt_final) {
      const photosCount = Array.isArray(session.photos) ? session.photos.length : 0;

      if (newCredits >= photosCount) {
        // Auto-continue generation
        await supabase
          .from("users")
          .update({ credits: newCredits - photosCount })
          .eq("id", user.id);

        await supabase
          .from("sessions")
          .update({ state: "processing" })
          .eq("id", session.id);

        await supabase.from("jobs").insert({
          session_id: session.id,
          user_id: user.id,
          status: "queued",
          attempts: 0,
        });

        await ctx.reply(await getText(lang, "photo.generation_continue"));
      } else {
        await ctx.reply(await getText(lang, "payment.need_more", {
          needed: photosCount - newCredits,
        }));
      }
    }
  }
});

// Webhook endpoint
app.post(config.webhookPath, async (req, res) => {
  if (config.telegramWebhookSecret) {
    const secret = req.header("x-telegram-bot-api-secret-token");
    if (secret !== config.telegramWebhookSecret) {
      return res.status(401).send({ ok: false });
    }
  }

  await bot.handleUpdate(req.body);
  res.status(200).send({ ok: true });
});

app.get("/health", (_, res) => res.status(200).send("OK"));

app.listen(config.port, () => {
  console.log(`API running on :${config.port}`);
});

async function startBot() {
  if (config.publicBaseUrl) {
    const baseUrl = config.publicBaseUrl.replace(/\/$/, "");
    const webhookUrl = `${baseUrl}${config.webhookPath}`;

    await bot.telegram.setWebhook(
      webhookUrl,
      config.telegramWebhookSecret ? { secret_token: config.telegramWebhookSecret } : undefined
    );

    console.log(`Webhook set: ${webhookUrl}`);
  } else {
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log("Bot launched with long polling");
  }
}

startBot().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
