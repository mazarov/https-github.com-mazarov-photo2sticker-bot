import express from "express";
import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification } from "./lib/alerts";

const bot = new Telegraf(config.telegramBotToken);
const app = express();
app.use(express.json({ limit: "10mb" }));

// Cache for agent data (refreshed every 5 minutes)
let agentCache: { data: any; timestamp: number } | null = null;
const AGENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for style presets
let stylePresetsCache: { data: any[]; timestamp: number } | null = null;
const STYLE_PRESETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for emotion presets
let emotionPresetsCache: { data: any[]; timestamp: number } | null = null;
const EMOTION_PRESETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for motion presets
let motionPresetsCache: { data: any[]; timestamp: number } | null = null;
const MOTION_PRESETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for prompt templates
let promptTemplatesCache: { data: Map<string, string>; timestamp: number } | null = null;
const PROMPT_TEMPLATES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function safeAnswerCbQuery(ctx: any, payload?: any) {
  if (typeof ctx?.answerCbQuery !== "function") return;
  ctx.answerCbQuery(payload).catch((err: any) => {
    console.warn("answerCbQuery failed:", err?.description || err?.message || err);
  });
}

interface StylePreset {
  id: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  emoji: string;
  sort_order: number;
  is_active: boolean;
}

interface EmotionPreset {
  id: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  emoji: string;
  sort_order: number;
  is_active: boolean;
}

interface MotionPreset {
  id: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  emoji: string;
  sort_order: number;
  is_active: boolean;
}

async function getStylePresets(): Promise<StylePreset[]> {
  const now = Date.now();
  if (stylePresetsCache && now - stylePresetsCache.timestamp < STYLE_PRESETS_CACHE_TTL) {
    return stylePresetsCache.data;
  }

  const { data } = await supabase
    .from("style_presets")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    stylePresetsCache = { data, timestamp: now };
  }
  return data || [];
}

async function sendStyleKeyboard(ctx: any, lang: string) {
  const presets = await getStylePresets();

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    row.push(
      Markup.button.callback(
        `${presets[i].emoji} ${lang === "ru" ? presets[i].name_ru : presets[i].name_en}`,
        `style_${presets[i].id}`
      )
    );
    if (presets[i + 1]) {
      row.push(
        Markup.button.callback(
          `${presets[i + 1].emoji} ${lang === "ru" ? presets[i + 1].name_ru : presets[i + 1].name_en}`,
          `style_${presets[i + 1].id}`
        )
      );
    }
    buttons.push(row);
  }

  await ctx.reply(
    await getText(lang, "photo.ask_style"),
    Markup.inlineKeyboard(buttons)
  );
}

async function getEmotionPresets(): Promise<EmotionPreset[]> {
  const now = Date.now();
  if (emotionPresetsCache && now - emotionPresetsCache.timestamp < EMOTION_PRESETS_CACHE_TTL) {
    return emotionPresetsCache.data;
  }

  const { data } = await supabase
    .from("emotion_presets")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    emotionPresetsCache = { data, timestamp: now };
  }
  return data || [];
}

async function sendEmotionKeyboard(ctx: any, lang: string) {
  const presets = await getEmotionPresets();

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    row.push(
      Markup.button.callback(
        `${presets[i].emoji} ${lang === "ru" ? presets[i].name_ru : presets[i].name_en}`,
        `emotion_${presets[i].id}`
      )
    );
    if (presets[i + 1]) {
      row.push(
        Markup.button.callback(
          `${presets[i + 1].emoji} ${lang === "ru" ? presets[i + 1].name_ru : presets[i + 1].name_en}`,
          `emotion_${presets[i + 1].id}`
        )
      );
    }
    buttons.push(row);
  }

  await ctx.reply(
    await getText(lang, "emotion.choose"),
    Markup.inlineKeyboard(buttons)
  );
}

async function getMotionPresets(): Promise<MotionPreset[]> {
  const now = Date.now();
  if (motionPresetsCache && now - motionPresetsCache.timestamp < MOTION_PRESETS_CACHE_TTL) {
    return motionPresetsCache.data;
  }

  const { data } = await supabase
    .from("motion_presets")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    motionPresetsCache = { data, timestamp: now };
  }
  return data || [];
}

async function sendMotionKeyboard(ctx: any, lang: string) {
  const presets = await getMotionPresets();

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    row.push(
      Markup.button.callback(
        `${presets[i].emoji} ${lang === "ru" ? presets[i].name_ru : presets[i].name_en}`,
        `motion_${presets[i].id}`
      )
    );
    if (presets[i + 1]) {
      row.push(
        Markup.button.callback(
          `${presets[i + 1].emoji} ${lang === "ru" ? presets[i + 1].name_ru : presets[i + 1].name_en}`,
          `motion_${presets[i + 1].id}`
        )
      );
    }
    buttons.push(row);
  }

  await ctx.reply(
    await getText(lang, "motion.choose"),
    Markup.inlineKeyboard(buttons)
  );
}

async function getPromptTemplate(id: string): Promise<string> {
  const now = Date.now();
  
  if (promptTemplatesCache && now - promptTemplatesCache.timestamp < PROMPT_TEMPLATES_CACHE_TTL) {
    return promptTemplatesCache.data.get(id) || "";
  }
  
  const { data } = await supabase
    .from("prompt_templates")
    .select("id, template");
  
  if (data) {
    const map = new Map<string, string>();
    for (const row of data) {
      map.set(row.id, row.template);
    }
    promptTemplatesCache = { data: map, timestamp: now };
    return map.get(id) || "";
  }
  
  return "";
}

function buildPromptFromTemplate(template: string, input: string): string {
  return template.replace(/{input}/g, input);
}

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

let botUsernameCache: string | null = config.botUsername || null;
async function getBotUsername(): Promise<string> {
  if (botUsernameCache) return botUsernameCache;
  const me = await bot.telegram.getMe();
  botUsernameCache = me.username || "bot";
  return botUsernameCache;
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

async function enqueueJob(sessionId: string, userId: string) {
  await supabase.from("jobs").insert({
    session_id: sessionId,
    user_id: userId,
    status: "queued",
    attempts: 0,
  });
}

async function sendProgressStart(ctx: any, sessionId: string, lang: string) {
  const msg = await ctx.reply(await getText(lang, "progress.step1"));
  if (msg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id })
      .eq("id", sessionId);
  }
}

async function startGeneration(
  ctx: any,
  user: any,
  session: any,
  lang: string,
  options: {
    generationType: "style" | "emotion" | "motion" | "text";
    promptFinal: string;
    userInput?: string | null;
    emotionPrompt?: string | null;
    selectedStyleId?: string | null;
    selectedEmotion?: string | null;
    textPrompt?: string | null;
  }
) {
  const creditsNeeded = 1;

  console.log("=== startGeneration ===");
  console.log("user.id:", user?.id);
  console.log("user.credits:", user?.credits, "type:", typeof user?.credits);
  console.log("creditsNeeded:", creditsNeeded);
  console.log("check (credits < needed):", user?.credits < creditsNeeded);

  if (user.credits < creditsNeeded) {
    // Send alert (async, non-blocking)
    sendAlert({
      type: "not_enough_credits",
      message: "Not enough credits!",
      details: {
        user: `@${user.username || user.telegram_id}`,
        type: options.generationType,
        style: options.selectedStyleId || "-",
        credits: user.credits,
        needed: creditsNeeded,
      },
    }).catch(console.error);

    await supabase
      .from("sessions")
      .update({
        state: "wait_buy_credit",
        pending_generation_type: options.generationType,
        user_input: options.userInput || session.user_input || null,
        prompt_final: options.promptFinal,
        emotion_prompt: options.emotionPrompt || null,
        selected_style_id: options.selectedStyleId || session.selected_style_id || null,
        selected_emotion: options.selectedEmotion || null,
        credits_spent: creditsNeeded,
        is_active: true,
      })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "photo.not_enough_credits", {
      needed: creditsNeeded,
      balance: user.credits,
    }));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  await supabase
    .from("users")
    .update({ credits: user.credits - creditsNeeded })
    .eq("id", user.id);

  const nextState = 
    options.generationType === "emotion" ? "processing_emotion" :
    options.generationType === "motion" ? "processing_motion" :
    options.generationType === "text" ? "processing_text" : "processing";

  await supabase
    .from("sessions")
    .update({
      user_input: options.userInput || session.user_input || null,
      prompt_final: options.promptFinal,
      emotion_prompt: options.emotionPrompt || null,
      selected_style_id: options.selectedStyleId || session.selected_style_id || null,
      selected_emotion: options.selectedEmotion || null,
      text_prompt: options.textPrompt || null,
      generation_type: options.generationType,
      credits_spent: creditsNeeded,
      state: nextState,
      is_active: true,
    })
    .eq("id", session.id);

  await enqueueJob(session.id, user.id);

  await sendProgressStart(ctx, session.id, lang);
}

// Credit packages: { credits, price_in_stars, label_ru, label_en, price_rub }
const CREDIT_PACKS = [
  { credits: 10, price: 150, price_rub: 150, label_ru: "🧪 Лайт", label_en: "🧪 Light" },
  { credits: 30, price: 300, price_rub: 300, label_ru: "⭐ Бро", label_en: "⭐ Bro" },
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
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .maybeSingle();
  if (error) {
    console.log("getActiveSession error:", error);
  }
  if (data) return data;

  // Fallback: some DB setups flip is_active to false on update
  console.log("getActiveSession fallback for user:", userId);
  const { data: fallback } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .neq("state", "canceled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return fallback;
}

// Helper: send buy credits menu
async function sendBuyCreditsMenu(ctx: any, user: any, messageText?: string) {
  const lang = user.lang || "en";
  const text = messageText || await getText(lang, "payment.balance", { credits: user.credits });

  const buttons: any[][] = [];

  // One button per row with full label
  for (const pack of CREDIT_PACKS) {
    const label = lang === "ru" ? pack.label_ru : pack.label_en;
    const unit = lang === "ru" ? "стикеров" : "stickers";
    buttons.push([
      Markup.button.callback(
        `${label}: ${pack.credits} ${unit} — ${pack.price}⭐ (${pack.price_rub}₽)`,
        `pack_${pack.credits}_${pack.price}`
      )
    ]);
  }

  // Button to buy Stars for rubles (RU only)
  if (lang === "ru") {
    buttons.push([
      Markup.button.url("💵 Купить Stars за ₽", "https://t.me/StarsZakupBot?start=ref_r_0477825983")
    ]);
  }

  const cancelText = await getText(lang, "btn.cancel");
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

    console.log("New user - language_code:", ctx.from?.language_code, "-> lang:", lang);

    const { data: created } = await supabase
      .from("users")
      .insert({ 
        telegram_id: telegramId, 
        lang, 
        credits: 0,
        username: ctx.from?.username || null,
      })
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

      // Send notification (async, non-blocking)
      sendNotification({
        type: "new_user",
        message: `@${ctx.from?.username || "no\\_username"} (${telegramId})\n🌐 Язык: ${lang}`,
      }).catch(console.error);
    }
  } else {
    // Update username if changed (user may change their Telegram username)
    const currentUsername = ctx.from?.username || null;
    if (user.username !== currentUsername) {
      await supabase
        .from("users")
        .update({ username: currentUsername })
        .eq("id", user.id);
      user.username = currentUsername;
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

// /balance command
bot.command("balance", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  const lang = user.lang || "en";
  const text = await getText(lang, "balance.info", { credits: user.credits || 0 });
  const btnText = await getText(lang, "btn.top_up");

  await ctx.reply(
    text,
    Markup.inlineKeyboard([[Markup.button.callback(btnText, "buy_credits")]])
  );
});

// /support command
bot.command("support", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const { data: user } = await supabase
    .from("users")
    .select("lang")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  const lang = user?.lang || "en";
  const message = await getText(lang, "support.message");
  const buttonText = await getText(lang, "support.button");

  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: [[
        { text: buttonText, url: "https://t.me/p2s_support_bot" }
      ]]
    }
  });
});

// Photo handler
bot.on("photo", async (ctx) => {
  const telegramId = ctx.from?.id;
  console.log("Photo received, telegramId:", telegramId);
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  console.log("Photo handler - session:", session?.id, "state:", session?.state);
  if (!session?.id) {
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
  if (!photo) return;

  const photos = Array.isArray(session.photos) ? session.photos : [];
  photos.push(photo.file_id);

  const { error } = await supabase
    .from("sessions")
    .update({ photos, state: "wait_style", is_active: true, current_photo_file_id: photo.file_id })
    .eq("id", session.id);
  if (error) {
    console.error("Failed to update session to wait_style:", error);
  }

  await sendStyleKeyboard(ctx, lang);
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

  if (session.state === "wait_custom_emotion") {
    const emotionText = ctx.message.text.trim();
    if (!session.last_sticker_file_id) {
      await ctx.reply(await getText(lang, "error.no_stickers_added"));
      return;
    }

    const emotionTemplate = await getPromptTemplate("emotion");
    const promptFinal = buildPromptFromTemplate(emotionTemplate, emotionText);
    await startGeneration(ctx, user, session, lang, {
      generationType: "emotion",
      promptFinal,
      emotionPrompt: emotionText,
      selectedEmotion: emotionText,
    });
    return;
  }

  if (session.state === "wait_custom_motion") {
    const motionText = ctx.message.text.trim();
    if (!session.last_sticker_file_id) {
      await ctx.reply(await getText(lang, "error.no_stickers_added"));
      return;
    }

    const motionTemplate = await getPromptTemplate("motion");
    const promptFinal = buildPromptFromTemplate(motionTemplate, motionText);
    await startGeneration(ctx, user, session, lang, {
      generationType: "motion",
      promptFinal,
      emotionPrompt: motionText,
      selectedEmotion: motionText,
    });
    return;
  }

  if (session.state === "wait_text") {
    const textInput = ctx.message.text.trim();
    if (!session.last_sticker_file_id) {
      await ctx.reply(await getText(lang, "error.no_stickers_added"));
      return;
    }

    const textTemplate = await getPromptTemplate("text");
    const promptFinal = buildPromptFromTemplate(textTemplate, textInput);
    await startGeneration(ctx, user, session, lang, {
      generationType: "text",
      promptFinal,
      textPrompt: textInput,
    });
    return;
  }

  if (session.state === "wait_custom_style") {
    const styleText = ctx.message.text.trim();
    const photos = Array.isArray(session.photos) ? session.photos : [];
    const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
    if (!currentPhotoId) {
      await ctx.reply(await getText(lang, "photo.need_photo"));
      return;
    }

    // Generate prompt using LLM with user's custom style
    await ctx.reply(await getText(lang, "photo.processing"));
    const promptResult = await generatePrompt(styleText);

    if (!promptResult.ok || promptResult.retry) {
      await ctx.reply(await getText(lang, "photo.invalid_style"));
      return;
    }

    const generatedPrompt = promptResult.prompt || styleText;
    await startGeneration(ctx, user, session, lang, {
      generationType: "style",
      promptFinal: generatedPrompt,
      userInput: styleText,
      selectedStyleId: "custom",
    });
    return;
  }

  // Check if we're in wait_style state
  if (session.state !== "wait_style") {
    if (session.state === "wait_photo") {
      await ctx.reply(await getText(lang, "photo.need_photo"));
    } else if (session.state === "wait_emotion") {
      await ctx.reply(await getText(lang, "emotion.choose"));
    }
    return;
  }

  const photos = Array.isArray(session.photos) ? session.photos : [];
  const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
  if (!currentPhotoId) {
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

  await startGeneration(ctx, user, session, lang, {
    generationType: "style",
    promptFinal: generatedPrompt,
    userInput,
  });
});

// Callback: style selection
bot.action(/^style_(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    console.log("Style callback triggered, telegramId:", telegramId);
    if (!telegramId) return;

    const user = await getUser(telegramId);
    console.log("Style callback - User:", user?.id, "credits:", user?.credits);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);
    console.log("Style callback - Session:", session?.id, "state:", session?.state);
    if (!session?.id || session.state !== "wait_style") {
      console.log("Session state mismatch, expected wait_style");
      return;
    }

    const styleId = ctx.match[1];
    console.log("Style ID:", styleId);
    const presets = await getStylePresets();
    const preset = presets.find((p) => p.id === styleId);
    if (!preset) {
      console.log("Preset not found for:", styleId);
      return;
    }

    // Handle custom style - ask user to describe
    if (preset.id === "custom") {
      await supabase
        .from("sessions")
        .update({ state: "wait_custom_style", is_active: true })
        .eq("id", session.id);
      await ctx.reply(await getText(lang, "style.custom_prompt"));
      return;
    }

    const photos = Array.isArray(session.photos) ? session.photos : [];
    const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
    if (!currentPhotoId) {
    await ctx.reply(await getText(lang, "photo.need_photo"));
    return;
  }

  // Use prompt_hint as userInput
  const userInput = preset.prompt_hint;

  // Generate prompt using LLM
  await ctx.reply(await getText(lang, "photo.processing"));

  const promptResult = await generatePrompt(userInput);

  if (!promptResult.ok || promptResult.retry) {
    await ctx.reply(await getText(lang, "photo.invalid_style"));
    return;
  }

    const generatedPrompt = promptResult.prompt || userInput;

    await startGeneration(ctx, user, session, lang, {
      generationType: "style",
      promptFinal: generatedPrompt,
      userInput,
      selectedStyleId: preset.id,
    });
  } catch (err) {
    console.error("Style callback error:", err);
  }
});

// Callback: add to pack (new format with sticker ID)
bot.action(/^add_to_pack:(.+)$/, async (ctx) => {
  console.log("=== add_to_pack:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  console.log("telegramId:", telegramId);
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId from callback:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "telegram_file_id:", sticker?.telegram_file_id?.substring(0, 30) + "...");

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  const botUsername = await getBotUsername();
  let stickerSetName = user.sticker_set_name || `p2s_${telegramId}_by_${botUsername}`.toLowerCase();
  const packTitle = await getText(lang, "sticker.pack_title");

  try {
    if (!user.sticker_set_name) {
      // Try to create new sticker set
      try {
        await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
          user_id: telegramId,
          name: stickerSetName,
          title: packTitle,
          stickers: [
            {
              sticker: sticker.telegram_file_id,
              format: "static",
              emoji_list: ["🔥"],
            },
          ],
        });
      } catch (createErr: any) {
        // If name is occupied, try with timestamp
        if (createErr.response?.data?.description?.includes("already occupied")) {
          console.log("Sticker set name occupied, trying with timestamp...");
          stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
          await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
            user_id: telegramId,
            name: stickerSetName,
            title: packTitle,
            stickers: [
              {
                sticker: sticker.telegram_file_id,
                format: "static",
                emoji_list: ["🔥"],
              },
            ],
          });
        } else {
          throw createErr;
        }
      }

      await supabase.from("users").update({ sticker_set_name: stickerSetName }).eq("id", user.id);
    } else {
      await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/addStickerToSet`, {
        user_id: telegramId,
        name: stickerSetName,
        sticker: {
          sticker: sticker.telegram_file_id,
          format: "static",
          emoji_list: ["🔥"],
        },
      });
    }

    await ctx.reply(await getText(lang, "sticker.added_to_pack", {
      link: `https://t.me/addstickers/${stickerSetName}`,
    }));
  } catch (err: any) {
    console.error("Add to pack error:", err.response?.data || err.message);
    await sendAlert({
      type: "api_error",
      message: `Add to pack failed: ${err.response?.data?.description || err.message}`,
      details: { 
        userId: user.id,
        telegramId,
        stickerSetName,
        errorCode: err.response?.data?.error_code,
      },
    });
    await ctx.reply(await getText(lang, "error.technical"));
  }
});

// Callback: add to pack (old format - fallback for old messages)
bot.action("add_to_pack", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  const botUsername = await getBotUsername();
  let stickerSetName = user.sticker_set_name || `p2s_${telegramId}_by_${botUsername}`.toLowerCase();
  const packTitle = await getText(lang, "sticker.pack_title");

  try {
    if (!user.sticker_set_name) {
      // Try to create new sticker set
      try {
        await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
          user_id: telegramId,
          name: stickerSetName,
          title: packTitle,
          stickers: [
            {
              sticker: session.last_sticker_file_id,
              format: "static",
              emoji_list: ["🔥"],
            },
          ],
        });
      } catch (createErr: any) {
        // If name is occupied, try with timestamp
        if (createErr.response?.data?.description?.includes("already occupied")) {
          console.log("Sticker set name occupied, trying with timestamp...");
          stickerSetName = `p2s_${telegramId}_${Date.now()}_by_${botUsername}`.toLowerCase();
          await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/createNewStickerSet`, {
            user_id: telegramId,
            name: stickerSetName,
            title: packTitle,
            stickers: [
              {
                sticker: session.last_sticker_file_id,
                format: "static",
                emoji_list: ["🔥"],
              },
            ],
          });
        } else {
          throw createErr;
        }
      }

      await supabase.from("users").update({ sticker_set_name: stickerSetName }).eq("id", user.id);
    } else {
      await axios.post(`https://api.telegram.org/bot${config.telegramBotToken}/addStickerToSet`, {
        user_id: telegramId,
        name: stickerSetName,
        sticker: {
          sticker: session.last_sticker_file_id,
          format: "static",
          emoji_list: ["🔥"],
        },
      });
    }

    await ctx.reply(await getText(lang, "sticker.added_to_pack", {
      link: `https://t.me/addstickers/${stickerSetName}`,
    }));
  } catch (err: any) {
    console.error("Add to pack error:", err.response?.data || err.message);
    await sendAlert({
      type: "api_error",
      message: `Add to pack failed: ${err.response?.data?.description || err.message}`,
      details: { 
        userId: user.id,
        telegramId,
        stickerSetName,
        errorCode: err.response?.data?.error_code,
      },
    });
    await ctx.reply(await getText(lang, "error.technical"));
  }
});

// Callback: change style (new format with sticker ID)
bot.action(/^change_style:(.+)$/, async (ctx) => {
  console.log("=== change_style:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "source_photo_file_id:", !!sticker?.source_photo_file_id);

  if (!sticker?.source_photo_file_id) {
    console.log(">>> ERROR: no source_photo_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  // Get or create active session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    // Create new session
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_style", is_active: true })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_style",
      is_active: true,
      current_photo_file_id: sticker.source_photo_file_id,
      prompt_final: null,
      user_input: null,
      pending_generation_type: null,
      selected_emotion: null,
      emotion_prompt: null,
    })
    .eq("id", session.id);

  await sendStyleKeyboard(ctx, lang);
});

// Callback: change style (old format - fallback)
bot.action("change_style", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_style",
      is_active: true,
      prompt_final: null,
      user_input: null,
      pending_generation_type: null,
      selected_emotion: null,
      emotion_prompt: null,
    })
    .eq("id", session.id);

  await sendStyleKeyboard(ctx, lang);
});

// Callback: change emotion (new format with sticker ID)
bot.action(/^change_emotion:(.+)$/, async (ctx) => {
  console.log("=== change_emotion:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "telegram_file_id:", !!sticker?.telegram_file_id);

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  // Get or create active session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_emotion", is_active: true })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_emotion",
      is_active: true,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  await sendEmotionKeyboard(ctx, lang);
});

// Callback: change emotion (old format - fallback)
bot.action("change_emotion", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  await supabase
    .from("sessions")
    .update({ state: "wait_emotion", is_active: true, pending_generation_type: null })
    .eq("id", session.id);

  await sendEmotionKeyboard(ctx, lang);
});

// Callback: emotion selection
bot.action(/^emotion_(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  const emotionId = ctx.match[1];
  const presets = await getEmotionPresets();
  const preset = presets.find((p) => p.id === emotionId);
  if (!preset) return;

  if (preset.id === "custom") {
    await supabase
      .from("sessions")
      .update({ state: "wait_custom_emotion", is_active: true })
      .eq("id", session.id);
    await ctx.reply(await getText(lang, "emotion.custom_prompt"));
    return;
  }

  const emotionTemplate = await getPromptTemplate("emotion");
  const promptFinal = buildPromptFromTemplate(emotionTemplate, preset.prompt_hint);
  await startGeneration(ctx, user, session, lang, {
    generationType: "emotion",
    promptFinal,
    emotionPrompt: preset.prompt_hint,
    selectedEmotion: preset.id,
  });
});

// Callback: change motion (new format with sticker ID)
bot.action(/^change_motion:(.+)$/, async (ctx) => {
  console.log("=== change_motion:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "telegram_file_id:", !!sticker?.telegram_file_id);

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  // Get or create active session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_motion", is_active: true })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_motion",
      is_active: true,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  await sendMotionKeyboard(ctx, lang);
});

// Callback: change motion (old format - fallback)
bot.action("change_motion", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  await supabase
    .from("sessions")
    .update({ state: "wait_motion", is_active: true, pending_generation_type: null })
    .eq("id", session.id);

  await sendMotionKeyboard(ctx, lang);
});

// Callback: motion selection
bot.action(/^motion_(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.last_sticker_file_id) {
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  const motionId = ctx.match[1];
  const presets = await getMotionPresets();
  const preset = presets.find((p) => p.id === motionId);
  if (!preset) return;

  if (preset.id === "custom") {
    await supabase
      .from("sessions")
      .update({ state: "wait_custom_motion", is_active: true })
      .eq("id", session.id);
    await ctx.reply(await getText(lang, "motion.custom_prompt"));
    return;
  }

  const motionTemplate = await getPromptTemplate("motion");
  const promptFinal = buildPromptFromTemplate(motionTemplate, preset.prompt_hint);
  await startGeneration(ctx, user, session, lang, {
    generationType: "motion",
    promptFinal,
    emotionPrompt: preset.prompt_hint,
    selectedEmotion: preset.id,
  });
});

// Callback: add text to sticker
bot.action(/^add_text:(.+)$/, async (ctx) => {
  console.log("=== add_text:ID callback ===");
  console.log("callback_data:", ctx.match?.[0]);
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker from DB by ID
  const { data: sticker } = await supabase
    .from("stickers")
    .select("telegram_file_id, source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("sticker from DB:", sticker?.user_id, "telegram_file_id:", !!sticker?.telegram_file_id);

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  // Get or create active session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_text", is_active: true })
      .select()
      .single();
    session = newSession;
  }

  if (!session?.id) return;

  await supabase
    .from("sessions")
    .update({
      state: "wait_text",
      is_active: true,
      last_sticker_file_id: sticker.telegram_file_id,
      current_photo_file_id: sticker.source_photo_file_id,
      pending_generation_type: null,
    })
    .eq("id", session.id);

  await ctx.reply(await getText(lang, "text.prompt"));
});

// Callback: buy_credits
bot.action("buy_credits", async (ctx) => {
  safeAnswerCbQuery(ctx);
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

  const cancelText = await getText(lang, "btn.canceled");
  safeAnswerCbQuery(ctx, cancelText);
  await ctx.deleteMessage().catch(() => {});

  if (!user?.id) return;

  const session = await getActiveSession(user.id);
  if (session?.state === "wait_buy_credit") {
    const nextState = session.pending_generation_type === "emotion" ? "wait_emotion" : "wait_style";
    await supabase
      .from("sessions")
      .update({ state: nextState, is_active: true })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "payment.canceled"));
  }
});

// Callback: pack_N_PRICE (e.g., pack_5_30)
bot.action(/^pack_(\d+)_(\d+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
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
    const title = await getText(lang, "payment.invoice_title", { credits });
    const description = await getText(lang, "payment.invoice_description", { credits });
    const label = await getText(lang, "payment.invoice_label");

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
  const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";

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
    const errorMsg = await getText(lang, "payment.transaction_not_found");
    await ctx.answerPreCheckoutQuery(false, errorMsg);
    return;
  }

  // Answer OK
  await ctx.answerPreCheckoutQuery(true);
});

// Successful payment handler
bot.on("successful_payment", async (ctx) => {
  const payment = ctx.message.successful_payment;
  const invoicePayload = payment.invoice_payload;

  // === PAYMENT DEBUG LOGS ===
  console.log("=== successful_payment received ===");
  console.log("charge_id:", payment.telegram_payment_charge_id);
  console.log("amount:", payment.total_amount);
  console.log("payload:", invoicePayload);
  console.log("timestamp:", new Date().toISOString());

  // Extract transaction ID
  const transactionId = invoicePayload.replace(/[\[\]]/g, "");
  console.log("transactionId:", transactionId);

  // Idempotency guard: if this charge was already processed, skip
  const { data: existingCharge } = await supabase
    .from("transactions")
    .select("id, state")
    .eq("telegram_payment_charge_id", payment.telegram_payment_charge_id)
    .maybeSingle();

  console.log("existingCharge check:", existingCharge?.id, existingCharge?.state);

  if (existingCharge?.state === "done") {
    console.log(">>> SKIP: Payment already processed by charge id:", payment.telegram_payment_charge_id);
    return;
  }

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
    .is("telegram_payment_charge_id", null)
    .select("*");

  const transaction = updatedTransactions?.[0];
  console.log("update result - transaction found:", !!transaction, "id:", transaction?.id);

  if (!transaction) {
    // Already processed or not found - this prevents double crediting
    console.log(">>> SKIP: Transaction already processed or not found:", transactionId);
    return;
  }

  // Get user and add credits
  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", transaction.user_id)
    .maybeSingle();

  // NOTE: Credits are added by Supabase trigger "on_transaction_done" -> "add_credits_on_transaction"
  // which fires AFTER UPDATE on transactions table when state becomes "done".
  // We do NOT add credits here to avoid double crediting.
  // The trigger is also used by other bots via n8n workflow.

  // Re-fetch user to get updated balance (after trigger executed)
  const { data: updatedUser } = await supabase
    .from("users")
    .select("*")
    .eq("id", transaction.user_id)
    .maybeSingle();

  const finalUser = updatedUser || user;
  console.log("user after trigger:", finalUser?.id, "credits:", finalUser?.credits, "added:", transaction.amount);

  if (finalUser) {
    const lang = finalUser.lang || "en";
    const currentCredits = finalUser.credits || 0;

    await ctx.reply(await getText(lang, "payment.success", {
      amount: transaction.amount,
      balance: currentCredits,
    }));

    // Send payment notification (async, non-blocking)
    sendNotification({
      type: "new_payment",
      message: `👤 @${finalUser.username || finalUser.telegram_id}\n📦 Пакет: ${transaction.amount} кредитов\n⭐ Сумма: ${transaction.price} Stars`,
    }).catch(console.error);

    // Check if there's a pending session waiting for credits
    const session = await getActiveSession(finalUser.id);
    if (session?.state === "wait_buy_credit" && session.prompt_final) {
      const creditsNeeded = session.credits_spent || 1;

      if (currentCredits >= creditsNeeded) {
        const nextState =
          session.pending_generation_type === "emotion" ? "processing_emotion" : "processing";

        // Auto-continue generation: deduct credits for the pending generation
        await supabase
          .from("users")
          .update({ credits: currentCredits - creditsNeeded })
          .eq("id", finalUser.id);

        await supabase
          .from("sessions")
          .update({ state: nextState, is_active: true })
          .eq("id", session.id);

        await enqueueJob(session.id, finalUser.id);

        await sendProgressStart(ctx, session.id, lang);
      } else {
        await ctx.reply(await getText(lang, "payment.need_more", {
          needed: creditsNeeded - currentCredits,
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

startBot().catch(async (err) => {
  console.error("Failed to start bot:", err);
  await sendAlert({
    type: "api_error",
    message: err?.message || String(err),
    stack: err?.stack,
  });
  process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", async (err) => {
  console.error("Uncaught exception:", err);
  await sendAlert({
    type: "api_error",
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", async (reason: any) => {
  console.error("Unhandled rejection:", reason);
  await sendAlert({
    type: "api_error",
    message: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// =============================================================================
// FEEDBACK CRON: отправка feedback-сообщений с кнопкой на support бот
// =============================================================================

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

    if (error) {
      console.error("Error fetching feedback triggers:", error);
      return;
    }

    if (!triggers?.length) return;

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
                  url: `https://t.me/${config.supportBotUsername}?start=feedback_${trigger.user_id}` 
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

// Запуск feedback cron после старта бота
setTimeout(() => {
  console.log("Starting feedback cron...");
  processFeedbackTriggers();
  setInterval(processFeedbackTriggers, 60 * 1000);
}, 5000);
