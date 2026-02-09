import express from "express";
import { Telegraf, Markup } from "telegraf";
import axios from "axios";
import { config } from "./config";
import { supabase } from "./lib/supabase";
import { getText } from "./lib/texts";
import { sendAlert, sendNotification } from "./lib/alerts";
import { getFilePath, downloadFile, sendSticker } from "./lib/telegram";
import { addWhiteBorder } from "./lib/image-utils";
import {
  buildSystemPrompt,
  callAIChat,
  type AssistantMessage,
  type AssistantContext,
} from "./lib/ai-chat";
import {
  createAssistantSession,
  getActiveAssistantSession,
  updateAssistantSession,
  closeAssistantSession,
  closeAllActiveAssistantSessions,
  handleToolCall,
  buildStateInjection,
  allParamsCollected,
  getAssistantParams,
  expireOldAssistantSessions,
  getLastGoalForUser,
  getRecentAssistantSession,
  reactivateAssistantSession,
  type AssistantSessionRow,
} from "./lib/assistant-db";

const bot = new Telegraf(config.telegramBotToken);

// Global error handler — catch all unhandled errors from handlers
bot.catch((err: any, ctx: any) => {
  console.error("=== BOT UNHANDLED ERROR ===");
  console.error("Update type:", ctx?.updateType);
  console.error("Error:", err?.message || err);
  if (err?.stack) console.error("Stack:", err.stack.split("\n").slice(0, 5).join("\n"));
  console.error("=== END ERROR ===");
});

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

// Style examples helpers
interface StyleExample {
  telegram_file_id: string;
  style_preset_id: string;
}

async function getStyleExample(styleId: string, offset: number = 0): Promise<StyleExample | null> {
  const { data } = await supabase
    .from("stickers")
    .select("telegram_file_id, style_preset_id")
    .eq("style_preset_id", styleId)
    .eq("is_example", true)
    .eq("env", config.appEnv)
    .not("telegram_file_id", "is", null)
    .order("created_at", { ascending: false })
    .range(offset, offset)
    .maybeSingle();
  
  return data;
}

async function countStyleExamples(styleId: string): Promise<number> {
  const { count } = await supabase
    .from("stickers")
    .select("id", { count: "exact", head: true })
    .eq("style_preset_id", styleId)
    .eq("is_example", true)
    .eq("env", config.appEnv)
    .not("telegram_file_id", "is", null);
  
  return count || 0;
}


// ============================================
// Style presets (flat list from style_presets_v2)
// ============================================

interface StylePresetV2 {
  id: string;
  group_id: string;
  emoji: string;
  name_ru: string;
  name_en: string;
  prompt_hint: string;
  sort_order: number;
  is_active: boolean;
  show_in_onboarding: boolean;
}

// Cache for style_presets_v2
let stylePresetsV2Cache: { data: StylePresetV2[]; timestamp: number } | null = null;
const STYLE_PRESETS_V2_CACHE_TTL = 5 * 60 * 1000;

async function getStylePresetsV2(groupId?: string): Promise<StylePresetV2[]> {
  const now = Date.now();
  if (stylePresetsV2Cache && now - stylePresetsV2Cache.timestamp < STYLE_PRESETS_V2_CACHE_TTL) {
    const cached = stylePresetsV2Cache.data;
    return groupId ? cached.filter(p => p.group_id === groupId) : cached;
  }

  const { data } = await supabase
    .from("style_presets_v2")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    stylePresetsV2Cache = { data, timestamp: now };
  }
  const result = data || [];
  return groupId ? result.filter(p => p.group_id === groupId) : result;
}

async function getStylePresetV2ById(id: string): Promise<StylePresetV2 | null> {
  const presets = await getStylePresetsV2();
  return presets.find(p => p.id === id) || null;
}

async function sendStyleKeyboardFlat(ctx: any, lang: string, messageId?: number) {
  const allPresets = await getStylePresetsV2();
  const exampleText = await getText(lang, "btn.example");
  const customText = await getText(lang, "btn.custom_style");

  // Style button + Example button in one row
  const buttons: any[][] = allPresets.map(s => [
    Markup.button.callback(
      `${s.emoji} ${lang === "ru" ? s.name_ru : s.name_en}`,
      `style_v2:${s.id}`
    ),
    Markup.button.callback(exampleText, `style_example_v2:${s.id}:${s.group_id}`)
  ]);

  // Custom style button
  buttons.push([{ text: customText, callback_data: "style_custom_v2" }]);

  const text = await getText(lang, "photo.ask_style");

  if (messageId) {
    await ctx.telegram.editMessageText(
      ctx.chat?.id,
      messageId,
      undefined,
      text,
      { reply_markup: { inline_keyboard: buttons } }
    ).catch((err: any) => console.error("sendStyleKeyboardFlat error:", err?.message));
  } else {
    await ctx.reply(text, Markup.inlineKeyboard(buttons));
  }
}

/**
 * Send style keyboard for assistant's "show examples" — same layout as sendStyleKeyboardFlat
 * but clicking a STYLE returns the choice to the assistant (not manual mode).
 * Clicking "Example" uses the standard style_example_v2 callback.
 */
async function sendStyleExamplesKeyboard(ctx: any, lang: string) {
  const allPresets = await getStylePresetsV2();
  const exampleText = await getText(lang, "btn.example");
  const isRu = lang === "ru";

  const buttons: any[][] = allPresets.map(s => [
    Markup.button.callback(
      `${s.emoji} ${isRu ? s.name_ru : s.name_en}`,
      `assistant_pick_style:${s.id}`
    ),
    Markup.button.callback(exampleText, `style_example_v2:${s.id}:${s.group_id}`)
  ]);

  const header = isRu
    ? "Выбери стиль или нажми «Пример» чтобы посмотреть:"
    : "Pick a style or tap «Example» to preview:";

  await ctx.reply(header, Markup.inlineKeyboard(buttons));
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

async function enqueueJob(sessionId: string, userId: string, isFirstFree: boolean = false) {
  await supabase.from("jobs").insert({
    session_id: sessionId,
    user_id: userId,
    status: "queued",
    attempts: 0,
    is_first_free: isFirstFree,
    env: config.appEnv,
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
    assistantParams?: { style: string; emotion: string; pose: string } | null;
  }
) {
  const creditsNeeded = 1;

  console.log("=== startGeneration ===");
  console.log("user.id:", user?.id);
  console.log("user.credits:", user?.credits, "type:", typeof user?.credits);
  console.log("user.has_purchased:", user.has_purchased);
  console.log("user.onboarding_step:", user.onboarding_step);
  console.log("generationType:", options.generationType);
  console.log("creditsNeeded:", creditsNeeded);

  // Check if user has enough credits
  if (user.credits < creditsNeeded) {
    // Paywall for users who haven't purchased yet
    const isPaywall = !user.has_purchased;
    
    sendAlert({
      type: isPaywall ? "paywall_shown" : "not_enough_credits",
      message: isPaywall ? "Paywall shown to new user" : "Not enough credits!",
      details: {
        user: `@${user.username || user.telegram_id}`,
        sessionId: session.id,
        generationType: options.generationType,
        styleGroup: session.selected_style_group || "-",
        styleId: options.selectedStyleId || "-",
        credits: user.credits,
        needed: creditsNeeded,
        hasPurchased: user.has_purchased,
      },
    }).catch(console.error);

    await supabase
      .from("sessions")
      .update({
        state: isPaywall ? "wait_first_purchase" : "wait_buy_credit",
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

    if (isPaywall) {
      // Show paywall message with bonus info
      await ctx.reply(await getText(lang, "paywall.message"));
    } else {
      await ctx.reply(await getText(lang, "photo.not_enough_credits", {
        needed: creditsNeeded,
        balance: user.credits,
      }));
    }
    await sendBuyCreditsMenu(ctx, user);

    // Mark paywall on assistant session (if active) for post-paywall sales behavior
    if (session.state?.startsWith("assistant_") || options.selectedStyleId === "assistant") {
      const aSession = await getActiveAssistantSession(user.id);
      if (aSession && !aSession.paywall_shown) {
        await updateAssistantSession(aSession.id, {
          paywall_shown: true,
          paywall_shown_at: new Date().toISOString(),
          sales_attempts: (aSession.sales_attempts || 0) + 1,
        });
      }
    }
    return;
  }

  // Deduct credits atomically (prevents race condition)
  const { data: deducted, error: deductError } = await supabase
    .rpc("deduct_credits", { p_user_id: user.id, p_amount: creditsNeeded });
  
  if (deductError || !deducted) {
    console.error("Atomic deduct failed - race condition detected:", deductError?.message || "not enough credits");
    await ctx.reply(await getText(lang, "photo.not_enough_credits", {
      needed: creditsNeeded,
      balance: 0,
    }));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Increment total_generations
  await supabase.rpc("increment_generations", { p_user_id: user.id });

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

  await enqueueJob(session.id, user.id, false);

  // Alert: generation started with all parameters
  const isAssistant = !!options.assistantParams;
  const mode = isAssistant ? "🤖 assistant" : "✋ manual";
  const goal = (() => {
    if (isAssistant) {
      const ap = options.assistantParams!;
      return `${ap.style} / ${ap.emotion} / ${ap.pose}`;
    }
    switch (options.generationType) {
      case "style": return `Стикер в стиле: ${options.selectedStyleId || options.userInput || "custom"}`;
      case "emotion": return `Эмоция: ${options.emotionPrompt || "?"}`;
      case "motion": return `Движение: ${options.emotionPrompt || "?"}`;
      case "text": return `Текст: ${options.textPrompt || "?"}`;
      default: return options.generationType;
    }
  })();

  const alertDetails: Record<string, any> = {
    mode,
    user: `@${user.username || user.telegram_id}`,
    goal,
  };

  if (isAssistant) {
    const ap = options.assistantParams!;
    alertDetails.style = ap.style;
    alertDetails.emotion = ap.emotion;
    alertDetails.pose = ap.pose;
  } else {
    alertDetails.style = options.selectedStyleId || "-";
    alertDetails.input = options.userInput || "-";
    alertDetails.emotion = options.emotionPrompt || "-";
    alertDetails.text = options.textPrompt || "-";
  }
  alertDetails.prompt = options.promptFinal.slice(0, 200);

  sendAlert({
    type: "generation_started",
    message: "New generation",
    details: alertDetails,
  }).catch(console.error);

  await sendProgressStart(ctx, session.id, lang);
}

// Credit packages: { credits, price_in_stars, label_ru, label_en, price_rub, adminOnly?, hidden? }
const CREDIT_PACKS = [
  { credits: 1, price: 1, price_rub: 1, label_ru: "🔧 Тест", label_en: "🔧 Test", adminOnly: true },
  { credits: 10, price: 150, price_rub: 99, label_ru: "⭐ Старт", label_en: "⭐ Start" },
  { credits: 30, price: 300, price_rub: 249, label_ru: "💎 Популярный", label_en: "💎 Popular" },
  { credits: 100, price: 700, price_rub: 699, label_ru: "👑 Про", label_en: "👑 Pro" },
  { credits: 250, price: 1500, price_rub: 1490, label_ru: "🚀 Макс", label_en: "🚀 Max" },
  // Hidden discount packs for abandoned carts (not shown in UI, used via direct callback)
  { credits: 10, price: 135, price_rub: 89, label_ru: "⭐ Старт -10%", label_en: "⭐ Start -10%", hidden: true },
  { credits: 30, price: 270, price_rub: 224, label_ru: "💎 Популярный -10%", label_en: "💎 Popular -10%", hidden: true },
];

/**
 * Build balance info string for check_balance tool.
 * Returned as context for AI to use in conversation.
 */
function buildBalanceInfo(user: any, lang: string): string {
  const packs = CREDIT_PACKS
    .filter((p: any) => !p.adminOnly && !p.hidden)
    .map((p: any) => `• ${p.credits} credits — ${p.price}⭐ (${(p.price / p.credits).toFixed(1)}⭐/стикер) ${lang === "ru" ? p.label_ru : p.label_en}`)
    .join("\n");

  return [
    `[BALANCE]`,
    `Credits: ${user.credits || 0}`,
    `Has purchased: ${!!user.has_purchased}`,
    `Total generations: ${user.total_generations || 0}`,
    ``,
    `Available packs:`,
    packs,
  ].join("\n");
}

// Helper: get user by telegram_id
async function getUser(telegramId: number) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("env", config.appEnv)
    .maybeSingle();
  return data;
}

// Helper: get persistent menu keyboard
function getMainMenuKeyboard(lang: string) {
  const row1 = lang === "ru"
    ? ["🤖 Помощник", "🎨 Стили"]
    : ["🤖 Assistant", "🎨 Styles"];
  const row2 = lang === "ru"
    ? ["💰 Баланс", "❓ Помощь"]
    : ["💰 Balance", "❓ Help"];

  return Markup.keyboard([row1, row2]).resize().persistent();
}

// Helper: check if language is in whitelist for free credits
function isAllowedLanguage(languageCode: string): boolean {
  const code = (languageCode || "").toLowerCase();
  return config.allowedLangPrefixes.some(prefix => code.startsWith(prefix));
}

// ============================================
// AI Assistant helpers
// ============================================

/**
 * Start a new AI assistant dialog: create session, call Gemini for greeting, reply to user.
 */
async function startAssistantDialog(ctx: any, user: any, lang: string) {
  // Fetch previous goal before closing sessions (for returning users)
  const prevAssistantSession = await getActiveAssistantSession(user.id);
  let previousGoal = prevAssistantSession?.goal || null;
  // Fallback: check completed/abandoned sessions if no active one
  if (!previousGoal) {
    previousGoal = await getLastGoalForUser(user.id);
  }
  if (previousGoal) {
    // Strip analytics tags like [trial: ...] from the goal
    previousGoal = previousGoal.replace(/\s*\[trial:.*?\]/g, "").replace(/\s*\[intent:.*?\]/g, "").trim() || null;
  }
  if (previousGoal) {
    console.log("startAssistantDialog: previous goal found:", previousGoal.slice(0, 80));
  }

  // Close any active assistant sessions for this user
  await closeAllActiveAssistantSessions(user.id);

  // Cancel all active sessions
  await supabase
    .from("sessions")
    .update({ state: "canceled", is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true);

  // Create new session with assistant state
  const { data: newSession, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      state: "assistant_wait_photo",
      is_active: true,
      env: config.appEnv,
    })
    .select()
    .single();

  if (sessionError || !newSession) {
    console.error("startAssistantDialog: Failed to create session:", sessionError?.message || "no data");
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  console.log("startAssistantDialog: Session created:", newSession.id, "for user:", user.id);

  // Build context for system prompt
  const stylePresets = await getStylePresetsV2();
  const availableStyles = stylePresets.map(s => 
    `${s.emoji} ${lang === "ru" ? s.name_ru : s.name_en}`
  );

  const assistantCtx: AssistantContext = {
    firstName: ctx.from?.first_name || "User",
    languageCode: user.language_code || ctx.from?.language_code || "en",
    isPremium: ctx.from?.is_premium || false,
    totalGenerations: user.total_generations || 0,
    credits: user.credits || 0,
    hasPhoto: false,
    previousGoal,
    availableStyles,
  };

  const systemPrompt = buildSystemPrompt(assistantCtx);

  // Create assistant_sessions row
  const initMessages: AssistantMessage[] = [
    { role: "system", content: systemPrompt },
  ];
  const aSession = await createAssistantSession(user.id, newSession.id, initMessages);
  if (!aSession) {
    console.error("startAssistantDialog: Failed to create assistant_session");
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  try {
    // Call AI to generate greeting (no state injection needed for first call)
    console.log("startAssistantDialog: Calling AI for greeting...");
    const result = await callAIChat([], systemPrompt);
    console.log("startAssistantDialog: AI response received, length:", result.text.length);

    // Handle tool call if present (usually request_photo on first call)
    if (result.toolCall) {
      console.log("startAssistantDialog: Tool call:", result.toolCall.name);
      const { action } = handleToolCall(result.toolCall, aSession);
      if (action === "photo") {
        // LLM asked for photo — state is already assistant_wait_photo, good
      }
    }

    // Save messages to assistant_sessions
    const messages: AssistantMessage[] = [
      ...initMessages,
      { role: "assistant", content: result.text },
    ];

    await updateAssistantSession(aSession.id, { messages });

    if (result.text) {
      await ctx.reply(result.text, getMainMenuKeyboard(lang));
    } else if (result.toolCall?.name === "request_photo") {
      // AI returned tool call with no text — send fallback photo request
      const photoRequest = lang === "ru"
        ? "Пришли мне фото, из которого хочешь сделать стикер 📸"
        : "Send me a photo you'd like to turn into a sticker 📸";
      await ctx.reply(photoRequest, getMainMenuKeyboard(lang));
    } else if (result.toolCall) {
      // Other tool call with no text — send generic prompt
      const fallbackMsg = lang === "ru"
        ? "Готов помочь! Расскажи, какой стикер хочешь сделать?"
        : "Ready to help! Tell me what kind of sticker you want to make?";
      await ctx.reply(fallbackMsg, getMainMenuKeyboard(lang));
    }
  } catch (err: any) {
    console.error("startAssistantDialog AI error:", err.message);
    // Fallback: hardcoded greeting
    const greeting = lang === "ru"
      ? `Привет, ${ctx.from?.first_name || ""}! 👋\nЯ — помощник по созданию стикеров.\nМоя задача — сделать так, чтобы результат тебе точно понравился.\n\nПришли мне фото, из которого хочешь сделать стикер.`
      : `Hi, ${ctx.from?.first_name || ""}! 👋\nI'm your sticker creation assistant.\nMy job is to make sure you love the result.\n\nSend me a photo you'd like to turn into a sticker.`;

    const messages: AssistantMessage[] = [
      ...initMessages,
      { role: "assistant", content: greeting },
    ];

    await updateAssistantSession(aSession.id, { messages });

    await ctx.reply(greeting, getMainMenuKeyboard(lang));
  }
}

/**
 * Handle assistant confirmation: start generation or show paywall.
 */
async function handleAssistantConfirm(ctx: any, user: any, sessionId: string, lang: string) {
  // Get assistant session for params
  const aSession = await getActiveAssistantSession(user.id);
  if (!aSession) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  // Re-fetch sessions row for generation
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) {
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
    return;
  }

  const params = getAssistantParams(aSession);
  const promptFinal = buildAssistantPrompt(params);

  // Keep assistant session active so user can continue dialog after generation
  // (e.g. "not what I wanted", "change emotion", etc.)
  // Session will be closed when user starts new dialog, switches to manual, or by timeout

  // Re-fetch user for fresh credits
  const freshUser = await getUser(user.telegram_id);
  if (!freshUser) return;

  await startGeneration(ctx, freshUser, session, lang, {
    generationType: "style",
    promptFinal,
    userInput: `[assistant] style: ${params.style}, emotion: ${params.emotion}, pose: ${params.pose}`,
    selectedStyleId: "assistant",
    assistantParams: params,
  });
}

/**
 * Count trial credits granted today (global, across all users).
 */
async function getTodayTrialCreditsCount(): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("assistant_sessions")
    .select("id", { count: "exact", head: true })
    .eq("env", config.appEnv)
    .gte("updated_at", todayStart.toISOString())
    .like("goal", "%[trial: grant%");

  return count || 0;
}

/**
 * Get system prompt with state injection for assistant session.
 * Looks for original system prompt in messages, appends current state.
 */
async function getAssistantSystemPrompt(
  messages: AssistantMessage[],
  aSession: AssistantSessionRow,
  userContext?: { credits: number; hasPurchased: boolean; totalGenerations: number }
): Promise<string> {
  const basePrompt = messages.find(m => m.role === "system")?.content || "";

  // Get available styles for show_style_examples tool
  const presets = await getStylePresets();
  const availableStyles = presets.map(s => ({ id: s.id, name_en: s.name_en }));

  // Inject trial budget only when user qualifies (new users with <= 2 generations)
  let trialBudgetRemaining: number | undefined;
  if (userContext
    && userContext.credits === 0
    && !userContext.hasPurchased
    && userContext.totalGenerations <= 2) {
    const todayCount = await getTodayTrialCreditsCount();
    trialBudgetRemaining = Math.max(0, 20 - todayCount);
  }

  return basePrompt + buildStateInjection(aSession, { availableStyles, trialBudgetRemaining });
}

/**
 * Process assistant AI result: handle tool call, update session, decide what to do next.
 * Returns the action to take and whether confirm button should be shown.
 */
async function processAssistantResult(
  result: { text: string; toolCall: import("./lib/ai-chat").ToolCall | null },
  aSession: AssistantSessionRow,
  messages: AssistantMessage[],
): Promise<{ action: "confirm" | "photo" | "show_mirror" | "show_examples" | "grant_credit" | "deny_credit" | "check_balance" | "normal"; updatedSession: AssistantSessionRow }> {
  let action: "confirm" | "photo" | "show_mirror" | "show_examples" | "grant_credit" | "deny_credit" | "check_balance" | "normal" = "normal";
  let sessionUpdates: Partial<AssistantSessionRow> = {};

  if (result.toolCall) {
    console.log("[Assistant] Tool call:", result.toolCall.name, JSON.stringify(result.toolCall.args));
    const toolResult = handleToolCall(result.toolCall, aSession);
    sessionUpdates = { ...toolResult.updates };

    if (toolResult.action === "confirm") {
      // Guard: don't confirm if params are missing — LLM jumped ahead
      if (!allParamsCollected({ ...aSession, ...sessionUpdates } as AssistantSessionRow)) {
        console.warn("[Assistant] confirm_and_generate called but params incomplete! style:", aSession.style, "emotion:", aSession.emotion, "pose:", aSession.pose, "— falling back to normal");
        // Don't set action to confirm — will fall through to "normal" and ask for missing param
      } else {
        action = "confirm";
      }
    } else if (toolResult.action === "photo") {
      action = "photo";
    } else if (toolResult.action === "show_examples") {
      action = "show_examples";
    } else if (toolResult.action === "grant_credit") {
      action = "grant_credit";
    } else if (toolResult.action === "deny_credit") {
      action = "deny_credit";
    } else if (toolResult.action === "check_balance") {
      action = "check_balance";
    } else if (toolResult.action === "params") {
      // After updating params, check if all collected
      const mergedSession = { ...aSession, ...sessionUpdates } as AssistantSessionRow;
      if (allParamsCollected(mergedSession)) {
        action = "show_mirror";
      }
    }
  }

  // Save messages and updates
  console.log("[Assistant] processResult: saving, action:", action, "updates keys:", Object.keys(sessionUpdates));
  await updateAssistantSession(aSession.id, {
    messages,
    ...sessionUpdates,
    error_count: 0, // reset on success
  });
  console.log("[Assistant] processResult: saved successfully");

  // Return merged session for downstream checks
  const updatedSession = { ...aSession, ...sessionUpdates } as AssistantSessionRow;
  return { action, updatedSession };
}

/**
 * Generate a fallback reply when LLM returns only a tool call (no text).
 * This ensures the user always gets a response.
 */
function generateFallbackReply(action: string, session: AssistantSessionRow, lang: string): string {
  const isRu = lang === "ru";

  if (action === "confirm") {
    return isRu ? "Отлично! Запускаю генерацию..." : "Great! Starting generation...";
  }

  if (action === "photo") {
    return isRu
      ? "Пришли мне фото, из которого хочешь сделать стикер 📸"
      : "Send me a photo you'd like to turn into a sticker 📸";
  }

  if (action === "show_mirror") {
    return buildMirrorMessage(session, lang);
  }

  if (action === "show_examples") {
    return isRu
      ? "Нажми на стиль, чтобы увидеть пример:"
      : "Tap a style to see an example:";
  }

  if (action === "grant_credit") {
    return isRu
      ? "Отлично! Сгенерирую этот стикер для тебя — уверен, результат понравится! 🎨"
      : "Great! I'll generate this sticker for you — I'm sure you'll love it! 🎨";
  }

  if (action === "deny_credit") {
    return isRu
      ? "Твоя идея отличная! Чтобы воплотить её, выбери пакет — 10 стикеров хватит для старта:"
      : "Your idea is great! To bring it to life, choose a pack — 10 stickers is enough to start:";
  }

  if (action === "check_balance") {
    return isRu ? "Секунду..." : "One moment...";
  }

  // action === "params" or "normal" — ask for next missing param
  if (!session.style) {
    return isRu
      ? "Принял! Теперь опиши стиль стикера (например: аниме, мультяшный, минимализм)"
      : "Got it! Now describe the sticker style (e.g.: anime, cartoon, minimal)";
  }
  if (!session.emotion) {
    return isRu
      ? "Отлично! Какую эмоцию хочешь передать?"
      : "Great! What emotion should the sticker express?";
  }
  if (!session.pose) {
    return isRu
      ? "Понял! Какую позу или жест выбираешь?"
      : "Got it! What pose or gesture do you want?";
  }

  return isRu ? "Продолжаем!" : "Let's continue!";
}

/**
 * Build a mirror message showing all collected params.
 */
function buildMirrorMessage(session: AssistantSessionRow, lang: string): string {
  const isRu = lang === "ru";
  const lines = [
    isRu ? "Проверь, правильно ли я понял:" : "Please check if I understood you correctly:",
    `– **${isRu ? "Стиль" : "Style"}:** ${session.style || "?"}`,
    `– **${isRu ? "Эмоция" : "Emotion"}:** ${session.emotion || "?"}`,
    `– **${isRu ? "Поза / жест" : "Pose / gesture"}:** ${session.pose || "?"}`,
    "",
    isRu ? "Если что-то не так — скажи, что изменить." : "If anything is off, tell me what to change.",
  ];
  return lines.join("\n");
}

/**
 * Handle show_style_examples tool — show style keyboard with examples.
 * Uses the same style_presets_v2 layout as manual mode but routes style clicks back to assistant.
 */
async function handleShowStyleExamples(ctx: any, styleId: string | undefined | null, lang: string): Promise<void> {
  if (styleId) {
    // Specific style requested — show example via existing helper
    const example = await getStyleExample(styleId);
    if (example?.telegram_file_id) {
      try { await ctx.replyWithSticker(example.telegram_file_id); } catch (err: any) {
        console.error("handleShowStyleExamples: send sticker failed:", err.message);
      }
    } else {
      const isRu = lang === "ru";
      await ctx.reply(isRu
        ? "Примера для этого стиля пока нет. Опиши стиль словами — я пойму!"
        : "No example for this style yet. Describe it in words — I'll understand!");
    }
  } else {
    // Show full style keyboard — style clicks go to assistant, example clicks use standard flow
    await sendStyleExamplesKeyboard(ctx, lang);
  }
}

/**
 * Build final prompt for Gemini image generation from assistant params.
 */
function buildAssistantPrompt(params: { style: string; emotion: string; pose: string }): string {
  return `Create a telegram sticker of the person from the photo.

Style: ${params.style}
Emotion: ${params.emotion}
Pose/gesture: ${params.pose}

Requirements:
- Solid black background (NOT white, NOT transparent) — critical for clean cutout
- Sticker-like proportions (head slightly larger)
- No outline/border around the character
- Expressive and recognizable
- High contrast between character and background`;
}

// Helper: get active session
async function getActiveSession(userId: string) {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .eq("env", config.appEnv)
    .order("created_at", { ascending: false })
    .maybeSingle();
  if (error) {
    console.log("getActiveSession error:", error.message, error.code);
  }
  if (data) return data;

  // Fallback: some DB setups flip is_active to false on update
  console.log("getActiveSession fallback for user:", userId);
  const { data: fallback } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("env", config.appEnv)
    .neq("state", "canceled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallback) {
    console.log("getActiveSession fallback found:", fallback.id, "state:", fallback.state, "is_active:", fallback.is_active);
  }
  return fallback;
}

/**
 * Handle grant_credit / deny_credit action from AI assistant.
 */
async function handleTrialCreditAction(
  ctx: any,
  action: "grant_credit" | "deny_credit",
  result: { text: string; toolCall: import("./lib/ai-chat").ToolCall | null },
  user: any,
  session: any,
  replyText: string | undefined,
  lang: string
): Promise<void> {
  if (action === "grant_credit") {
    // Code ALWAYS verifies limits — even if AI said "grant"
    const todayCount = await getTodayTrialCreditsCount();

    // Check if this user already received a trial credit (prevent duplicates)
    const { count: userTrialCount } = await supabase
      .from("assistant_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .like("goal", "%[trial: grant%");
    const alreadyGranted = (userTrialCount || 0) > 0;

    const canGrant = todayCount < 20
      && (user.credits || 0) === 0
      && !user.has_purchased
      && (user.total_generations || 0) <= 2
      && !alreadyGranted;

    if (canGrant) {
      await supabase
        .from("users")
        .update({ credits: 1 })
        .eq("id", user.id);

      sendAlert({
        type: "trial_credit_granted",
        message: `🎁 Trial credit #${todayCount + 1}/20`,
        details: {
          user: `@${user.username || user.telegram_id}`,
          confidence: result.toolCall?.args?.confidence,
          reason: result.toolCall?.args?.reason,
          isPremium: user.is_premium,
          lang: user.language_code || user.lang,
        },
      }).catch(console.error);

      // Re-fetch user with updated credits, then generate
      const freshUser = await getUser(user.telegram_id);
      if (replyText) await ctx.reply(replyText);
      if (freshUser) await handleAssistantConfirm(ctx, freshUser, session.id, lang);
    } else {
      // Budget exhausted or guard triggered — fallback to paywall
      const paywallText = lang === "ru"
        ? "К сожалению, сейчас не могу сгенерировать бесплатно. Выбери пакет — 10 стикеров хватит для старта:"
        : "Unfortunately, I can't generate for free right now. Choose a pack — 10 stickers is enough to start:";
      await ctx.reply(paywallText);
      await sendBuyCreditsMenu(ctx, user);

      // Mark paywall shown on assistant session for post-paywall behavior
      const aSession = await getActiveAssistantSession(user.id);
      if (aSession) {
        await updateAssistantSession(aSession.id, {
          paywall_shown: true,
          paywall_shown_at: new Date().toISOString(),
          sales_attempts: (aSession.sales_attempts || 0) + 1,
        });
      }
    }
  } else {
    // deny_credit
    sendAlert({
      type: "trial_credit_denied",
      message: `❌ Trial denied`,
      details: {
        user: `@${user.username || user.telegram_id}`,
        confidence: result.toolCall?.args?.confidence,
        reason: result.toolCall?.args?.reason,
      },
    }).catch(console.error);

    if (replyText) await ctx.reply(replyText);
    await sendBuyCreditsMenu(ctx, user);

    // Mark paywall shown on assistant session for post-paywall behavior
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      await updateAssistantSession(aSession.id, {
        paywall_shown: true,
        paywall_shown_at: new Date().toISOString(),
        sales_attempts: (aSession.sales_attempts || 0) + 1,
      });
    }
  }
}

// Helper: send buy credits menu
async function sendBuyCreditsMenu(ctx: any, user: any, messageText?: string) {
  const lang = user.lang || "en";
  const text = messageText || await getText(lang, "payment.balance", { credits: user.credits });
  const isAdmin = config.adminIds.includes(user.telegram_id);

  // Filter packs: hide adminOnly (unless admin) and hidden packs
  const availablePacks = CREDIT_PACKS.filter(p => !p.hidden && (!p.adminOnly || isAdmin));

  const buttons: any[][] = [];

  // One button per row with full label
  for (const pack of availablePacks) {
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
    const languageCode = ctx.from?.language_code || "";
    const lang = languageCode.toLowerCase().startsWith("ru") ? "ru" : "en";

    console.log("New user - language_code:", languageCode, "-> lang:", lang);

    const { data: created, error: insertError } = await supabase
      .from("users")
      .insert({ 
        telegram_id: telegramId, 
        lang, 
        language_code: languageCode || null,  // save original language code
        credits: 1,
        has_purchased: false,
        username: ctx.from?.username || null,
        env: config.appEnv,
      })
      .select("*")
      .single();

    if (insertError) {
      console.error("User insert error:", insertError);
      // Race condition: user might already exist, try to fetch again
      if (insertError.code === "23505") {  // unique_violation
        const { data: existingUser } = await supabase
          .from("users")
          .select("*")
          .eq("telegram_id", telegramId)
          .maybeSingle();
        user = existingUser;
        isNewUser = false;
        console.log("User already exists, fetched:", user?.id);
      }
    } else {
      user = created;
    }

    // 1 free credit for first generation
    // Paywall shows on 2nd generation if no purchase
    // Bonus +2 credits given on first purchase

    // Send notification (async, non-blocking)
    if (user?.id) {
      sendNotification({
        type: "new_user",
        message: `@${ctx.from?.username || "no\\_username"} (${telegramId})\n🌐 Язык: ${languageCode || "unknown"}`,
      }).catch(console.error);
    }
  } else {
    // Update username and lang if changed
    const currentUsername = ctx.from?.username || null;
    const currentLangCode = ctx.from?.language_code || "";
    const currentLang = currentLangCode.toLowerCase().startsWith("ru") ? "ru" : "en";
    const updates: Record<string, any> = {};

    if (user.username !== currentUsername) updates.username = currentUsername;
    if (user.lang !== currentLang) updates.lang = currentLang;
    if (user.language_code !== currentLangCode) updates.language_code = currentLangCode || null;

    if (Object.keys(updates).length > 0) {
      await supabase.from("users").update(updates).eq("id", user.id);
      Object.assign(user, updates);
    }
  }

  if (user?.id) {
    const lang = user.lang || "en";
    // Start AI assistant dialog (cancels old sessions inside)
    await startAssistantDialog(ctx, user, lang);
  } else {
    const lang = "en";
    await ctx.reply(await getText(lang, "error.technical"), getMainMenuKeyboard(lang));
  }
});

// /balance command - shows balance + tariffs directly (no intermediate "Top up" button)
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
  await sendBuyCreditsMenu(ctx, user, text);
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

  // === AI Assistant: re-route to assistant_wait_photo if assistant is active after generation ===
  if (!session.state?.startsWith("assistant_") && !["processing", "processing_emotion", "processing_motion", "processing_text"].includes(session.state)) {
    const activeAssistant = await getActiveAssistantSession(user.id);
    if (activeAssistant && activeAssistant.status === "active") {
      console.log("Assistant photo re-route: state was", session.state, "→ switching to assistant_wait_photo");
      await supabase.from("sessions")
        .update({ state: "assistant_wait_photo", is_active: true })
        .eq("id", session.id);
      session.state = "assistant_wait_photo";
      session.is_active = true;
    }
  }

  // === AI Assistant: waiting for photo ===
  if (session.state === "assistant_wait_photo") {
    console.log("Assistant photo: received, session:", session.id);
    const aSession = await getActiveAssistantSession(user.id);
    if (!aSession) { console.error("Assistant photo: no assistant_session"); return; }

    const photos = Array.isArray(session.photos) ? session.photos : [];
    photos.push(photo.file_id);

    // Save photo and move to assistant_chat
    const { error: updateErr } = await supabase
      .from("sessions")
      .update({
        photos,
        current_photo_file_id: photo.file_id,
        state: "assistant_chat",
        is_active: true,
      })
      .eq("id", session.id);

    if (updateErr) {
      console.error("Assistant photo: session update error:", updateErr.message);
    }
    console.log("Assistant photo: state updated to assistant_chat");

    // Get existing messages and add photo event
    const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
    messages.push({ role: "user", content: "[User sent a photo]" });

    // Build system prompt with state injection (including trial budget if applicable)
    const systemPrompt = await getAssistantSystemPrompt(messages, aSession, {
      credits: user.credits || 0,
      hasPurchased: !!user.has_purchased,
      totalGenerations: user.total_generations || 0,
    });
    console.log("Assistant photo: calling AI, messages count:", messages.length);

    try {
      const result = await callAIChat(messages, systemPrompt);
      console.log("Assistant photo: AI response received, length:", result.text.length);
      messages.push({ role: "assistant", content: result.text });

      const { action, updatedSession } = await processAssistantResult(result, aSession, messages);

      // Generate fallback text if LLM returned only a tool call
      let replyText = result.text;
      if (!replyText && result.toolCall) {
        replyText = generateFallbackReply(action, updatedSession, lang);
        messages[messages.length - 1] = { role: "assistant", content: replyText };
        await updateAssistantSession(aSession.id, { messages });
      }

      if (action === "show_mirror") {
        const mirror = buildMirrorMessage(updatedSession, lang);
        await ctx.reply(mirror);
        await ctx.reply(
          lang === "ru" ? "Всё верно?" : "Is everything correct?",
          Markup.inlineKeyboard([
            [Markup.button.callback(
              lang === "ru" ? "✅ Подтвердить" : "✅ Confirm",
              "assistant_confirm"
            )],
          ])
        );
      } else if (action === "show_examples") {
        const styleId = result.toolCall?.args?.style_id;
        await handleShowStyleExamples(ctx, styleId, lang);
        if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
      } else if (action === "grant_credit" || action === "deny_credit") {
        // Re-fetch user to get fresh credits (user may have purchased during conversation)
        const freshUserPhoto = await getUser(user.telegram_id);
        if (freshUserPhoto && (freshUserPhoto.credits || 0) > 0) {
          console.log("[assistant_photo] User has credits after re-fetch:", freshUserPhoto.credits, "— generating");
          if (replyText) await ctx.reply(replyText);
          await handleAssistantConfirm(ctx, freshUserPhoto, session.id, lang);
        } else {
          await handleTrialCreditAction(ctx, action, result, freshUserPhoto || user, session, replyText, lang);
        }
      } else if (action === "check_balance") {
        const freshUserBal2 = await getUser(user.telegram_id);
        const u2 = freshUserBal2 || user;
        const balanceInfo2 = buildBalanceInfo(u2, lang);
        console.log("[assistant_photo] check_balance:", u2.credits);
        messages.push({ role: "assistant", content: balanceInfo2 });
        const sp2 = await getAssistantSystemPrompt(messages, aSession, {
          credits: u2.credits || 0, hasPurchased: !!u2.has_purchased, totalGenerations: u2.total_generations || 0,
        });
        const r2 = await callAIChat(messages, sp2);
        messages.push({ role: "assistant", content: r2.text || "" });
        await updateAssistantSession(aSession.id, { messages });
        if (r2.text) await ctx.reply(r2.text, getMainMenuKeyboard(lang));
      } else if (replyText) {
        await ctx.reply(replyText, getMainMenuKeyboard(lang));
      }
      console.log("Assistant photo: reply sent to user");
    } catch (err: any) {
      console.error("Assistant photo handler AI error:", err.message, err.response?.status, err.response?.data);
      const fallback = lang === "ru"
        ? "Отличное фото! Опиши стиль стикера своими словами (например: аниме, мультяшный, минимализм и т.д.)"
        : "Great photo! Describe the sticker style in your own words (e.g.: anime, cartoon, minimal, etc.)";
      messages.push({ role: "assistant", content: fallback });

      await updateAssistantSession(aSession.id, { messages });

      await ctx.reply(fallback, getMainMenuKeyboard(lang));
      console.log("Assistant photo: fallback reply sent");
    }
    return;
  }

  // === AI Assistant: new photo during active dialog ===
  if (session.state === "assistant_chat") {
    // Store new photo file_id in assistant_sessions for later use
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      await updateAssistantSession(aSession.id, { pending_photo_file_id: photo.file_id });
    }

    await ctx.reply(
      lang === "ru"
        ? "Вижу новое фото! С каким будем работать?"
        : "New photo! Which one should we use?",
      Markup.inlineKeyboard([
        [Markup.button.callback(
          lang === "ru" ? "✅ Новое фото" : "✅ New photo",
          "assistant_new_photo"
        )],
        [Markup.button.callback(
          lang === "ru" ? "❌ Оставить прежнее" : "❌ Keep current",
          "assistant_keep_photo"
        )],
      ])
    );
    return;
  }

  // === Manual mode: existing logic ===
  const photos = Array.isArray(session.photos) ? session.photos : [];
  photos.push(photo.file_id);

  const { error } = await supabase
    .from("sessions")
    .update({ photos, state: "wait_style", is_active: true, current_photo_file_id: photo.file_id })
    .eq("id", session.id);
  if (error) {
    console.error("Failed to update session to wait_style:", error);
  }

  await sendStyleKeyboardFlat(ctx, lang);
});

// ============================================
// Persistent menu handlers (Reply Keyboard)
// ============================================

// Menu: 🤖 Помощник — launch or continue AI assistant dialog
bot.hears(["🤖 Помощник", "🤖 Assistant"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang));
    return;
  }

  const lang = user.lang || "en";

  // If already in assistant dialog — ignore
  const session = await getActiveSession(user.id);
  if (session?.state?.startsWith("assistant_")) {
    return;
  }

  // Start new assistant dialog (implemented in step 4)
  await startAssistantDialog(ctx, user, lang);
});

// Menu: 🎨 Стили — manual style selection mode
bot.hears(["🎨 Стили", "🎨 Styles"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang));
    return;
  }

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);

  // If user is in assistant mode, cancel it and switch to manual
  if (session?.state?.startsWith("assistant_")) {
    console.log("Styles: switching from assistant to manual mode, session:", session.id);
    await closeAllActiveAssistantSessions(user.id, "abandoned");
    await supabase
      .from("sessions")
      .update({ state: "wait_style" })
      .eq("id", session.id);
  }

  // Check if user has a photo in active session
  if (!session || !session.current_photo_file_id) {
    await ctx.reply(await getText(lang, "photo.need_photo"), getMainMenuKeyboard(lang));
    return;
  }

  // Show flat style keyboard (manual mode)
  await sendStyleKeyboardFlat(ctx, lang);
});

// Menu: 💰 Баланс — show balance + credit packs
bot.hears(["💰 Баланс", "💰 Balance"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"), getMainMenuKeyboard(lang));
    return;
  }

  await sendBuyCreditsMenu(ctx, user);
});

// Menu: ❓ Помощь
bot.hears(["❓ Помощь", "❓ Help"], async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  const lang = user?.lang || "en";
  await ctx.reply(await getText(lang, "menu.help"), getMainMenuKeyboard(lang));
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

  // === AI Assistant: re-route to assistant after sticker generation ===
  // If user was in assistant flow and sticker was generated, session.state moved to
  // confirm_sticker/wait_style/etc. but assistant_session is still active.
  // Route text back to assistant so user can request changes or continue dialog.
  if (!session.state?.startsWith("assistant_") && !["processing", "processing_emotion", "processing_motion", "processing_text"].includes(session.state)) {
    let activeAssistant = await getActiveAssistantSession(user.id);
    console.log("Re-route check: state=", session.state, "activeAssistant=", activeAssistant?.id || "null", "status=", activeAssistant?.status || "n/a");

    // Fallback: if no active session found, check for recently-updated session (may have been unexpectedly closed)
    if (!activeAssistant) {
      const recent = await getRecentAssistantSession(user.id);
      if (recent) {
        console.log("Re-route fallback: found recent session", recent.id, "status:", recent.status, "updated:", recent.updated_at);
        // Reactivate it so the user can continue dialog
        await reactivateAssistantSession(recent.id);
        activeAssistant = { ...recent, status: "active" };
      }
    }

    if (activeAssistant) {
      console.log("Assistant re-route: state was", session.state, "→ switching to assistant_chat, aSession:", activeAssistant.id);
      await supabase.from("sessions")
        .update({ state: "assistant_chat", is_active: true })
        .eq("id", session.id);
      // Update local session object for downstream handlers
      session.state = "assistant_chat";
      session.is_active = true;
    }
  }

  // === AI Assistant: waiting for photo but got text — forward to AI ===
  // AI will respond naturally (about goal) and remind about photo when appropriate
  if (session.state === "assistant_wait_photo") {
    console.log("Assistant wait_photo text: session:", session.id, "is_active:", session.is_active);
    if (!session.is_active) {
      await supabase.from("sessions").update({ is_active: true }).eq("id", session.id);
    }
    const aSession = await getActiveAssistantSession(user.id);
    if (!aSession) { console.error("assistant_wait_photo: no assistant_session"); return; }

    const userText = ctx.message.text.trim();
    const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
    messages.push({ role: "user", content: userText });

    const systemPrompt = await getAssistantSystemPrompt(messages, aSession, {
      credits: user.credits || 0,
      hasPurchased: !!user.has_purchased,
      totalGenerations: user.total_generations || 0,
    });

    try {
      const result = await callAIChat(messages, systemPrompt);
      messages.push({ role: "assistant", content: result.text });

      // Extract goal from early conversation (before photo)
      const goalUpdate: Partial<AssistantSessionRow> = {};
      if (!aSession.goal) {
        goalUpdate.goal = userText; // User's first text is likely the goal
      }

      // Process tool call (may get request_photo or show_examples)
      let toolUpdates: Partial<AssistantSessionRow> = {};
      let toolAction: import("./lib/assistant-db").ToolAction | "none" = "none";
      if (result.toolCall) {
        console.log("[Assistant] wait_photo tool call:", result.toolCall.name);
        const { updates, action: ta } = handleToolCall(result.toolCall, aSession);
        toolUpdates = updates;
        toolAction = ta;
      }

      await updateAssistantSession(aSession.id, {
        messages,
        ...toolUpdates,
        ...goalUpdate,
      });

      if (toolAction === "show_examples") {
        const styleId = result.toolCall?.args?.style_id;
        await handleShowStyleExamples(ctx, styleId, lang);
        if (result.text) await ctx.reply(result.text, getMainMenuKeyboard(lang));
      } else if (toolAction === "grant_credit" || toolAction === "deny_credit") {
        const freshUserWP = await getUser(user.telegram_id);
        if (freshUserWP && (freshUserWP.credits || 0) > 0) {
          console.log("[wait_photo_text] User has credits after re-fetch:", freshUserWP.credits, "— generating");
          if (result.text) await ctx.reply(result.text);
          await handleAssistantConfirm(ctx, freshUserWP, session.id, lang);
        } else {
          await handleTrialCreditAction(ctx, toolAction as "grant_credit" | "deny_credit", result, freshUserWP || user, session, result.text, lang);
        }
      } else if (toolAction === "check_balance") {
        const freshUserBal3 = await getUser(user.telegram_id);
        const u3 = freshUserBal3 || user;
        const balanceInfo3 = buildBalanceInfo(u3, lang);
        console.log("[wait_photo_text] check_balance:", u3.credits);
        messages.push({ role: "assistant", content: balanceInfo3 });
        await updateAssistantSession(aSession.id, { messages });
        const sp3 = await getAssistantSystemPrompt(messages, aSession, {
          credits: u3.credits || 0, hasPurchased: !!u3.has_purchased, totalGenerations: u3.total_generations || 0,
        });
        const r3 = await callAIChat(messages, sp3);
        messages.push({ role: "assistant", content: r3.text || "" });
        await updateAssistantSession(aSession.id, { messages });
        if (r3.text) await ctx.reply(r3.text, getMainMenuKeyboard(lang));
      } else {
        const replyText = result.text || (lang === "ru"
          ? "Понял! Пришли фото для стикера 📸"
          : "Got it! Send me a photo for the sticker 📸");
        await ctx.reply(replyText, getMainMenuKeyboard(lang));
      }
    } catch (err: any) {
      console.error("Assistant wait_photo text AI error:", err.message);
      const reminder = lang === "ru"
        ? "Понял! А теперь пришли фото — из которого сделаем стикер 📸"
        : "Got it! Now send me a photo — I'll turn it into a sticker 📸";
      messages.push({ role: "assistant", content: reminder });

      await updateAssistantSession(aSession.id, { messages });

      await ctx.reply(reminder, getMainMenuKeyboard(lang));
    }
    return;
  }

  // === AI Assistant: active dialog (handles all: collecting params, confirming, changing) ===
  if (session.state === "assistant_chat") {
    console.log("Assistant chat: text received, session:", session.id, "user:", user.id, "is_active:", session.is_active);
    // Ensure is_active stays true (some DB setups reset it on update)
    if (!session.is_active) {
      await supabase.from("sessions").update({ is_active: true }).eq("id", session.id);
    }
    const aSession = await getActiveAssistantSession(user.id);
    if (!aSession) { console.error("assistant_chat: no assistant_session"); return; }
    console.log("Assistant chat: aSession found:", aSession.id, "style:", aSession.style, "emotion:", aSession.emotion, "pose:", aSession.pose);

    const userText = ctx.message.text.trim();
    const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
    messages.push({ role: "user", content: userText });

    // Build system prompt with state injection (tells LLM what's collected, including trial budget)
    const systemPrompt = await getAssistantSystemPrompt(messages, aSession, {
      credits: user.credits || 0,
      hasPurchased: !!user.has_purchased,
      totalGenerations: user.total_generations || 0,
    });

    // Track error count
    const errorCount = aSession.error_count || 0;

    try {
      console.log("Assistant chat: calling AI, messages count:", messages.length);
      const result = await callAIChat(messages, systemPrompt);
      console.log("Assistant chat: AI response received, text length:", result.text.length, "toolCall:", result.toolCall?.name || "none");
      messages.push({ role: "assistant", content: result.text });

      const { action, updatedSession } = await processAssistantResult(result, aSession, messages);
      console.log("Assistant chat: processResult done, action:", action);

      // Generate fallback text if LLM returned only a tool call (no text)
      let replyText = result.text;
      if (!replyText && result.toolCall) {
        replyText = generateFallbackReply(action, updatedSession, lang);
        console.log("Assistant chat: using fallback reply, length:", replyText.length);
        // Update messages with fallback text
        messages[messages.length - 1] = { role: "assistant", content: replyText };
        await updateAssistantSession(aSession.id, { messages });
      }

      console.log("Assistant chat: sending reply, action:", action, "replyText length:", replyText?.length || 0);

      try {
        if (action === "confirm") {
          // LLM decided user confirmed — trigger generation
          if (replyText) await ctx.reply(replyText);
          await handleAssistantConfirm(ctx, user, session.id, lang);
        } else if (action === "show_mirror") {
          // All params collected — show mirror + confirm button
          const mirror = buildMirrorMessage(updatedSession, lang);
          await ctx.reply(mirror);
          await ctx.reply(
            lang === "ru" ? "Всё верно?" : "Is everything correct?",
            Markup.inlineKeyboard([
              [Markup.button.callback(
                lang === "ru" ? "✅ Подтвердить" : "✅ Confirm",
                "assistant_confirm"
              )],
            ])
          );
        } else if (action === "photo") {
          // LLM wants a photo — switch state
          await supabase
            .from("sessions")
            .update({ state: "assistant_wait_photo", is_active: true })
            .eq("id", session.id);
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
        } else if (action === "show_examples") {
          // Show style examples to help user choose
          const styleId = result.toolCall?.args?.style_id;
          await handleShowStyleExamples(ctx, styleId, lang);
          // Send LLM reply text after examples (if any)
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
        } else if (action === "grant_credit" || action === "deny_credit") {
          // Re-fetch user to get fresh credits (user may have purchased during conversation)
          const freshUser = await getUser(user.telegram_id);
          if (freshUser && (freshUser.credits || 0) > 0) {
            // User now has credits (bought during conversation) — skip trial, go to generation
            console.log("[assistant_chat] User has credits after re-fetch:", freshUser.credits, "— skipping trial, generating");
            if (replyText) await ctx.reply(replyText);
            await handleAssistantConfirm(ctx, freshUser, session.id, lang);
          } else {
            await handleTrialCreditAction(ctx, action, result, freshUser || user, session, replyText, lang);
          }
        } else if (action === "check_balance") {
          // Fetch fresh user data and build balance info
          const freshUserBal = await getUser(user.telegram_id);
          const u = freshUserBal || user;
          const balanceInfo = buildBalanceInfo(u, lang);
          console.log("[assistant_chat] check_balance:", balanceInfo.split("\n").slice(0, 3).join(", "));

          // Add balance data to conversation and call AI again for natural response
          messages.push({ role: "assistant", content: balanceInfo });
          const systemPrompt2 = await getAssistantSystemPrompt(messages, aSession, {
            credits: u.credits || 0,
            hasPurchased: !!u.has_purchased,
            totalGenerations: u.total_generations || 0,
          });
          const result2 = await callAIChat(messages, systemPrompt2);
          messages.push({ role: "assistant", content: result2.text || "" });
          await updateAssistantSession(aSession.id, { messages });

          // Process the follow-up response (may contain another tool call)
          const { action: action2, updatedSession: uSession2 } = await processAssistantResult(result2, aSession, messages);
          const reply2 = result2.text || generateFallbackReply(action2, uSession2, lang);

          if (action2 === "confirm") {
            if (reply2) await ctx.reply(reply2);
            await handleAssistantConfirm(ctx, u, session.id, lang);
          } else {
            if (reply2) await ctx.reply(reply2, getMainMenuKeyboard(lang));
          }
        } else {
          // Normal dialog step
          if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
        }
        console.log("Assistant chat: reply sent to user, action:", action);
      } catch (replyErr: any) {
        console.error("Assistant chat: REPLY ERROR:", replyErr?.message || replyErr, "code:", replyErr?.code, "description:", replyErr?.description);
        // Try plain text fallback without keyboard
        try {
          if (replyText) await ctx.reply(replyText);
          console.log("Assistant chat: plain reply sent after error");
        } catch (plainErr: any) {
          console.error("Assistant chat: PLAIN REPLY ALSO FAILED:", plainErr?.message);
        }
      }
    } catch (err: any) {
      console.error("Assistant chat AI error:", err.message, err?.response?.status, err?.response?.data?.error?.message);
      const newErrorCount = errorCount + 1;

      await updateAssistantSession(aSession.id, { error_count: newErrorCount });

      if (newErrorCount >= 3) {
        // Level 3: escape to manual mode
        await closeAssistantSession(aSession.id, "error");
        const escapeMsg = lang === "ru"
          ? "К сожалению, помощник временно недоступен 😔\nНажми 🎨 Стили, чтобы выбрать стиль вручную."
          : "Unfortunately, the assistant is temporarily unavailable 😔\nTap 🎨 Styles to choose a style manually.";
        await ctx.reply(escapeMsg, getMainMenuKeyboard(lang));
      } else {
        // Level 2: soft fallback
        const retryMsg = lang === "ru"
          ? "Произошла ошибка, попробуй написать ещё раз."
          : "Something went wrong, please try again.";
        await ctx.reply(retryMsg, getMainMenuKeyboard(lang));
      }

      sendAlert({
        type: "assistant_gemini_error" as any,
        message: `Assistant AI error (attempt ${newErrorCount})`,
        details: {
          user: `@${user.username || user.telegram_id}`,
          sessionId: session.id,
          error: err.message?.slice(0, 200),
        },
      }).catch(console.error);
    }
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

  // Handle custom style v2 (same logic, different state name)
  if (session.state === "wait_custom_style_v2") {
    const styleText = ctx.message.text.trim();
    const photos = Array.isArray(session.photos) ? session.photos : [];
    const currentPhotoId = session.current_photo_file_id || photos[photos.length - 1];
    if (!currentPhotoId) {
      await ctx.reply(await getText(lang, "photo.need_photo"));
      return;
    }

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
      selectedStyleId: "custom_v2",
    });
    return;
  }

  // Check if we're in wait_style state
  if (session.state !== "wait_style") {
    if (session.state === "wait_photo") {
      await ctx.reply(await getText(lang, "photo.need_photo"));
    } else if (session.state === "wait_emotion") {
      await ctx.reply(await getText(lang, "emotion.choose"));
    } else if (session.state === "confirm_sticker") {
      // User sent text after sticker generation but re-route didn't find an assistant session
      // Suggest they start a new assistant dialog or use manual mode
      console.log("confirm_sticker text fallback: user sent text but no active assistant. Text:", ctx.message.text?.slice(0, 50));
      const msg = lang === "ru"
        ? "Нажми 🤖 Помощник, чтобы создать новый стикер, или 🎨 Стили для ручного режима."
        : "Tap 🤖 Assistant to create a new sticker, or 🎨 Styles for manual mode.";
      await ctx.reply(msg, getMainMenuKeyboard(lang));
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

// Callback: style selection (legacy v1 — excludes style_v2, style_example, style_custom, style_group)
bot.action(/^style_(?!v2:|example|custom|group)([^:]+)$/, async (ctx) => {
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

// ============================================
// Styles v2 handlers (isolated, only for enabled users)
// ============================================

// Callback: style group selected (v2)
bot.action(/^style_group:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    
    // Legacy handler - groups are no longer used, redirect to flat list
    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";
    await sendStyleKeyboardFlat(ctx, lang, ctx.callbackQuery?.message?.message_id);
  } catch (err) {
    console.error("Style group callback error:", err);
  }
});

// Callback: substyle selected (v2)
bot.action(/^style_v2:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);
    if (!session?.id || session.state !== "wait_style") return;

    const styleId = ctx.match[1];
    console.log("[Styles v2] Substyle selected:", styleId);

    const preset = await getStylePresetV2ById(styleId);
    if (!preset) {
      console.log("[Styles v2] Preset not found:", styleId);
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
    console.error("Style v2 callback error:", err);
  }
});

// Callback: back to groups (v2)
bot.action(/^style_groups_back(:.*)?$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    // Legacy handler - redirect to flat list
    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";
    await sendStyleKeyboardFlat(ctx, lang, ctx.callbackQuery?.message?.message_id);
  } catch (err) {
    console.error("Style groups back callback error:", err);
  }
});

// Callback: example for v2 substyle
bot.action(/^style_example_v2:(.+):(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;


    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const substyleId = ctx.match[1];
    const groupId = ctx.match[2];
    
    console.log("[Styles v2] Example requested:", substyleId, "groupId:", groupId);

    // Get substyle name
    const preset = await getStylePresetV2ById(substyleId);
    const styleName = preset 
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : substyleId;

    // Get example from stickers table
    const { data: example } = await supabase
      .from("stickers")
      .select("telegram_file_id")
      .eq("style_preset_id", substyleId)
      .eq("is_example", true)
      .not("telegram_file_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Count total examples
    const { count: totalExamples } = await supabase
      .from("stickers")
      .select("id", { count: "exact", head: true })
      .eq("style_preset_id", substyleId)
      .eq("is_example", true)
      .not("telegram_file_id", "is", null);

    console.log("[Styles v2] Example found:", !!example?.telegram_file_id, "total:", totalExamples);

    const backText = await getText(lang, "btn.back_to_styles");

    if (!example?.telegram_file_id) {
      // No examples - edit message to show text
      const noExamplesText = await getText(lang, "style.no_examples");
      await ctx.editMessageText(noExamplesText, {
        reply_markup: {
          inline_keyboard: [[{ text: backText, callback_data: `back_to_substyles_v2:${groupId}` }]]
        }
      });
      return;
    }

    // Delete old message
    await ctx.deleteMessage().catch(() => {});

    // Send sticker
    const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);

    // Build buttons
    const titleText = await getText(lang, "style.example_title", { style: styleName });
    const moreText = await getText(lang, "btn.more");
    const buttons: any[][] = [];
    
    if ((totalExamples || 0) > 1) {
      buttons.push([
        { text: moreText, callback_data: `style_example_v2_more:${substyleId}:${groupId}:1` },
        { text: backText, callback_data: `back_to_substyles_v2:${groupId}` }
      ]);
    } else {
      buttons.push([{ text: backText, callback_data: `back_to_substyles_v2:${groupId}` }]);
    }

    const captionMsg = await ctx.reply(titleText, {
      reply_markup: { inline_keyboard: buttons }
    });

    // Auto-delete after 30 seconds
    const chatId = ctx.chat?.id;
    if (chatId) {
      setTimeout(() => {
        ctx.telegram.deleteMessage(chatId, stickerMsg.message_id).catch(() => {});
        ctx.telegram.deleteMessage(chatId, captionMsg.message_id).catch(() => {});
      }, 30000);
    }
  } catch (err) {
    console.error("Style example v2 error:", err);
  }
});

// Callback: back to styles (from example) - now shows flat list
bot.action(/^back_to_substyles_v2:(.+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";

    // Delete current message and show flat style list
    await ctx.deleteMessage().catch(() => {});
    await sendStyleKeyboardFlat(ctx, lang);
  } catch (err) {
    console.error("Back to styles from example error:", err);
  }
});

// Callback: more examples v2
bot.action(/^style_example_v2_more:(.+):(.+):(\d+)$/, async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;


    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const substyleId = ctx.match[1];
    const groupId = ctx.match[2];
    const offset = parseInt(ctx.match[3], 10);

    console.log("[Styles v2] More examples:", substyleId, "offset:", offset);

    const backText = await getText(lang, "btn.back_to_styles");

    // Max 3 examples
    if (offset >= 3) {
      const noMoreText = await getText(lang, "style.no_more_examples");
      await ctx.editMessageText(noMoreText, {
        reply_markup: {
          inline_keyboard: [[{ text: backText, callback_data: `back_to_substyles_v2:${groupId}` }]]
        }
      });
      return;
    }

    // Get next example
    const { data: examples } = await supabase
      .from("stickers")
      .select("telegram_file_id")
      .eq("style_preset_id", substyleId)
      .eq("is_example", true)
      .not("telegram_file_id", "is", null)
      .order("created_at", { ascending: false })
      .range(offset, offset);

    const example = examples?.[0];

    if (!example?.telegram_file_id) {
      const noMoreText = await getText(lang, "style.no_more_examples");
      await ctx.editMessageText(noMoreText, {
        reply_markup: {
          inline_keyboard: [[{ text: backText, callback_data: `back_to_substyles_v2:${groupId}` }]]
        }
      });
      return;
    }

    // Delete old messages (sticker + caption)
    await ctx.deleteMessage().catch(() => {});

    // Send new sticker
    const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);

    // Get substyle name
    const preset = await getStylePresetV2ById(substyleId);
    const styleName = preset 
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : substyleId;
    const titleText = await getText(lang, "style.example_title", { style: styleName });
    const moreText = await getText(lang, "btn.more");

    const captionMsg = await ctx.reply(titleText, {
      reply_markup: {
        inline_keyboard: [[
          { text: moreText, callback_data: `style_example_v2_more:${substyleId}:${groupId}:${offset + 1}` },
          { text: backText, callback_data: `back_to_substyles_v2:${groupId}` }
        ]]
      }
    });

    // Auto-delete after 30 seconds
    const chatId = ctx.chat?.id;
    if (chatId) {
      setTimeout(() => {
        ctx.telegram.deleteMessage(chatId, stickerMsg.message_id).catch(() => {});
        ctx.telegram.deleteMessage(chatId, captionMsg.message_id).catch(() => {});
      }, 30000);
    }
  } catch (err) {
    console.error("Style example v2 more error:", err);
  }
});

// Callback: custom style (v2)
bot.action("style_custom_v2", async (ctx) => {
  try {
    safeAnswerCbQuery(ctx);
    const telegramId = ctx.from?.id;
    if (!telegramId) return;


    const user = await getUser(telegramId);
    if (!user?.id) return;

    const lang = user.lang || "en";
    const session = await getActiveSession(user.id);
    if (!session?.id || session.state !== "wait_style") return;

    // Switch state to wait for custom style text
    await supabase
      .from("sessions")
      .update({ state: "wait_custom_style_v2", is_active: true })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "style.custom_prompt_v2"));
  } catch (err) {
    console.error("Style custom v2 callback error:", err);
  }
});

// ============================================
// End of Styles v2 handlers
// ============================================

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
        user: `@${user.username || telegramId}`,
        stickerId,
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
        user: `@${user.username || telegramId}`,
        sessionId: session?.id || "-",
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
      .insert({ user_id: user.id, state: "wait_style", is_active: true, env: config.appEnv })
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

  await sendStyleKeyboardFlat(ctx, lang);
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

  await sendStyleKeyboardFlat(ctx, lang);
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
      .insert({ user_id: user.id, state: "wait_emotion", is_active: true, env: config.appEnv })
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
      .insert({ user_id: user.id, state: "wait_motion", is_active: true, env: config.appEnv })
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
      .insert({ user_id: user.id, state: "wait_text", is_active: true, env: config.appEnv })
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

// Callback: toggle white border on sticker (post-processing, no credits)
bot.action(/^toggle_border:(.+)$/, async (ctx) => {
  console.log("=== toggle_border:ID callback ===");
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
    .select("telegram_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  console.log("toggle_border sticker from DB:", sticker?.user_id, "telegram_file_id:", !!sticker?.telegram_file_id);

  if (!sticker?.telegram_file_id) {
    console.log(">>> ERROR: no telegram_file_id for sticker", stickerId);
    await ctx.reply(await getText(lang, "error.no_stickers_added"));
    return;
  }

  // Verify sticker belongs to user
  if (sticker.user_id !== user.id) {
    return;
  }

  try {
    // Show processing indicator
    const processingMsg = await ctx.reply(lang === "ru" ? "🔲 Добавляю обводку..." : "🔲 Adding border...");

    // Download current sticker via Telegram API
    const filePath = await getFilePath(sticker.telegram_file_id);
    const stickerBuffer = await downloadFile(filePath);
    console.log("toggle_border: downloaded sticker, size:", stickerBuffer.length);

    // Add white border via image processing
    const borderedBuffer = await addWhiteBorder(stickerBuffer);
    console.log("toggle_border: bordered buffer size:", borderedBuffer.length);

    // Build buttons (same as post-generation)
    const addToPackText = await getText(lang, "btn.add_to_pack");
    const assistantText = lang === "ru" ? "🤖 Ассистент" : "🤖 Assistant";
    const changeEmotionText = await getText(lang, "btn.change_emotion");
    const changeMotionText = await getText(lang, "btn.change_motion");
    const addTextText = await getText(lang, "btn.add_text");
    const toggleBorderText = await getText(lang, "btn.toggle_border");

    const replyMarkup = {
      inline_keyboard: [
        [{ text: addToPackText, callback_data: `add_to_pack:${stickerId}` }],
        [
          { text: assistantText, callback_data: "assistant_restart" },
          { text: changeEmotionText, callback_data: `change_emotion:${stickerId}` },
        ],
        [
          { text: changeMotionText, callback_data: `change_motion:${stickerId}` },
          { text: toggleBorderText, callback_data: `toggle_border:${stickerId}` },
        ],
        [
          { text: addTextText, callback_data: `add_text:${stickerId}` },
        ],
      ],
    };

    // Send bordered sticker
    const newFileId = await sendSticker(telegramId, borderedBuffer, replyMarkup);
    console.log("toggle_border: sent bordered sticker, new file_id:", newFileId?.substring(0, 30) + "...");

    // Update telegram_file_id in DB
    if (newFileId) {
      await supabase
        .from("stickers")
        .update({ telegram_file_id: newFileId })
        .eq("id", stickerId);
      console.log("toggle_border: updated sticker telegram_file_id");
    }

    // Delete processing message
    try {
      await ctx.deleteMessage(processingMsg.message_id);
    } catch (e) {
      // ignore
    }

    // Upload bordered version to storage (background, non-critical)
    const storagePath = `stickers/${user.id}/bordered_${Date.now()}.webp`;
    supabase.storage
      .from(config.supabaseStorageBucket)
      .upload(storagePath, borderedBuffer, { contentType: "image/webp", upsert: true })
      .then(() => console.log("toggle_border: storage upload done"))
      .catch((err: any) => console.error("toggle_border: storage upload failed:", err));

  } catch (err: any) {
    console.error("toggle_border error:", err);
    await ctx.reply(await getText(lang, "error.technical"));
  }
});

// ============================================
// AI Assistant callbacks
// ============================================

// Callback: assistant picks a style from the examples keyboard
bot.action(/^assistant_pick_style:(.+)$/, async (ctx) => {
  safeAnswerCbQuery(ctx);
  const styleId = ctx.match[1];
  const telegramId = ctx.from?.id;
  if (!telegramId || !styleId) return;

  try {
    const user = await getUser(telegramId);
    if (!user?.id) return;
    const lang = user.lang || "en";

    // Get style name
    const preset = await getStylePresetV2ById(styleId);
    const styleName = preset
      ? (lang === "ru" ? preset.name_ru : preset.name_en)
      : styleId;

    // Update assistant session with chosen style
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      await updateAssistantSession(aSession.id, { style: styleName });
      console.log("assistant_pick_style:", styleId, "→", styleName, "aSession:", aSession.id);

      // Build response through AI to continue flow naturally
      const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
      messages.push({ role: "user", content: `[User selected style: ${styleName}]` });

      const systemPrompt = await getAssistantSystemPrompt(messages, { ...aSession, style: styleName } as AssistantSessionRow);
      const result = await callAIChat(messages, systemPrompt);
      messages.push({ role: "assistant", content: result.text });

      await updateAssistantSession(aSession.id, { style: styleName, messages });

      const replyText = result.text || (lang === "ru"
        ? `Отлично, стиль: ${styleName}! Какую эмоцию хочешь передать?`
        : `Great, style: ${styleName}! What emotion should the sticker express?`);
      await ctx.reply(replyText, getMainMenuKeyboard(lang));
    } else {
      // No active assistant session — just acknowledge
      await ctx.reply(lang === "ru"
        ? `Стиль: ${styleName}. Нажми 🤖 Помощник чтобы начать.`
        : `Style: ${styleName}. Tap 🤖 Assistant to start.`);
    }
  } catch (err: any) {
    console.error("assistant_pick_style callback error:", err.message);
  }
});

// Callback: assistant confirm — user presses [✅ Confirm] button
bot.action("assistant_confirm", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);

  if (!session?.id || !session.state?.startsWith("assistant_")) return;

  // Check if user qualifies for trial credit — route through AI for grant/deny decision
  const qualifiesForTrial = (user.credits || 0) === 0
    && !user.has_purchased
    && (user.total_generations || 0) <= 2;

  if (qualifiesForTrial) {
    const aSession = await getActiveAssistantSession(user.id);
    if (!aSession) {
      await handleAssistantConfirm(ctx, user, session.id, lang);
      return;
    }

    // Check duplicate: already received trial credit
    const { count: userTrialCount } = await supabase
      .from("assistant_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("env", config.appEnv)
      .like("goal", "%[trial: grant%");
    const alreadyGranted = (userTrialCount || 0) > 0;

    if (alreadyGranted) {
      // Already got trial — go straight to generation (will show paywall if no credits)
      await handleAssistantConfirm(ctx, user, session.id, lang);
      return;
    }

    // Inject "user confirmed" into AI conversation so it can call grant_trial_credit
    const messages: AssistantMessage[] = Array.isArray(aSession.messages) ? [...aSession.messages] : [];
    messages.push({ role: "user", content: lang === "ru" ? "Подтверждаю" : "Confirm" });

    const systemPrompt = await getAssistantSystemPrompt(messages, aSession, {
      credits: user.credits || 0,
      hasPurchased: !!user.has_purchased,
      totalGenerations: user.total_generations || 0,
    });

    try {
      console.log("[assistant_confirm] Trial-eligible user, routing through AI...");
      const result = await callAIChat(messages, systemPrompt);
      console.log("[assistant_confirm] AI response:", result.toolCall?.name || "no tool", "text:", result.text?.length || 0);
      messages.push({ role: "assistant", content: result.text || "" });

      const { action, updatedSession } = await processAssistantResult(result, aSession, messages);
      console.log("[assistant_confirm] action:", action);

      let replyText = result.text;
      if (!replyText && result.toolCall) {
        replyText = generateFallbackReply(action, updatedSession, lang);
        messages[messages.length - 1] = { role: "assistant", content: replyText };
        await updateAssistantSession(aSession.id, { messages });
      }

      if (action === "grant_credit" || action === "deny_credit") {
        // Re-fetch user to get fresh credits (user may have purchased during conversation)
        const freshUserConfirm = await getUser(user.telegram_id);
        if (freshUserConfirm && (freshUserConfirm.credits || 0) > 0) {
          console.log("[assistant_confirm] User has credits after re-fetch:", freshUserConfirm.credits, "— generating");
          if (replyText) await ctx.reply(replyText);
          await handleAssistantConfirm(ctx, freshUserConfirm, session.id, lang);
        } else {
          await handleTrialCreditAction(ctx, action, result, freshUserConfirm || user, session, replyText, lang);
        }
      } else if (action === "confirm") {
        // AI decided to confirm directly (shouldn't happen but safe fallback)
        if (replyText) await ctx.reply(replyText);
        await handleAssistantConfirm(ctx, user, session.id, lang);
      } else {
        // AI returned something else — show text + paywall as fallback
        if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
      }
    } catch (err: any) {
      console.error("[assistant_confirm] AI error for trial user:", err.message);
      // Fallback: go to normal confirm (will show paywall)
      await handleAssistantConfirm(ctx, user, session.id, lang);
    }
    return;
  }

  await handleAssistantConfirm(ctx, user, session.id, lang);
});

// Callback: assistant restart — start new assistant dialog from post-generation button
bot.action("assistant_restart", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  await startAssistantDialog(ctx, user, lang);
});

// Callback: assistant new photo — user chose to use new photo
bot.action("assistant_new_photo", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id) return;

  const aSession = await getActiveAssistantSession(user.id);
  const newPhotoFileId = aSession?.pending_photo_file_id;
  if (!newPhotoFileId) {
    await ctx.reply(lang === "ru" ? "Фото не найдено, пришли ещё раз." : "Photo not found, please send again.");
    return;
  }
  const photos = Array.isArray(session.photos) ? session.photos : [];
  photos.push(newPhotoFileId);

  // Update photo and notify assistant
  const messages: AssistantMessage[] = Array.isArray(aSession!.messages) ? [...aSession!.messages] : [];
  messages.push({ role: "user", content: "[User sent a new photo and chose to use it]" });

  const systemPrompt = await getAssistantSystemPrompt(messages, aSession!);

  try {
    const result = await callAIChat(messages, systemPrompt);
    messages.push({ role: "assistant", content: result.text });

    // Process tool call if any
    let toolUpdates: Partial<AssistantSessionRow> = {};
    let toolAction = "none";
    if (result.toolCall) {
      const { updates, action: ta } = handleToolCall(result.toolCall, aSession!);
      toolUpdates = updates;
      toolAction = ta;
    }

    await updateAssistantSession(aSession!.id, {
      messages,
      pending_photo_file_id: null,
      ...toolUpdates,
    });

    await supabase
      .from("sessions")
      .update({
        photos,
        current_photo_file_id: newPhotoFileId,
        state: "assistant_chat",
        is_active: true,
      })
      .eq("id", session.id);

    if (toolAction === "show_examples") {
      const styleId = result.toolCall?.args?.style_id;
      await handleShowStyleExamples(ctx, styleId, lang);
      if (result.text) await ctx.reply(result.text, getMainMenuKeyboard(lang));
    } else {
      await ctx.reply(result.text, getMainMenuKeyboard(lang));
    }
  } catch (err: any) {
    console.error("Assistant new photo error:", err.message);
    await supabase
      .from("sessions")
      .update({ photos, current_photo_file_id: newPhotoFileId })
      .eq("id", session.id);

    const msg = lang === "ru"
      ? "Фото обновлено! Продолжаем — опиши стиль стикера."
      : "Photo updated! Let's continue — describe the sticker style.";
    await ctx.reply(msg, getMainMenuKeyboard(lang));
  }
});

// Callback: assistant keep photo — user chose to keep current photo
bot.action("assistant_keep_photo", async (ctx) => {
  safeAnswerCbQuery(ctx);
  const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
  const msg = lang === "ru" ? "Хорошо, работаем с текущим фото!" : "Ok, keeping the current photo!";
  await ctx.reply(msg);
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
    const thankYouText = "⭐".repeat(score) + " Спасибо за оценку! 🙏";
    await ctx.editMessageText(thankYouText);
  }
});

// Callback: make_example (admin only - from alert channel)
bot.action(/^make_example:(.+)$/, async (ctx) => {
  console.log("=== make_example callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Check if admin
  if (!config.adminIds.includes(telegramId)) {
    console.log("User not admin:", telegramId);
    return;
  }

  const stickerId = ctx.match[1];
  console.log("stickerId:", stickerId);

  // Get sticker to check style_preset_id
  const { data: sticker } = await supabase
    .from("stickers")
    .select("id, style_preset_id, is_example")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker) {
    console.log("Sticker not found");
    await ctx.editMessageText("❌ Стикер не найден");
    return;
  }

  if (!sticker.style_preset_id) {
    console.log("Sticker has no style_preset_id");
    await ctx.editMessageText("❌ У стикера нет стиля");
    return;
  }

  if (sticker.is_example) {
    console.log("Sticker already an example");
    await ctx.editMessageText("✅ Уже является примером");
    return;
  }

  // Mark as example
  const { error } = await supabase
    .from("stickers")
    .update({ is_example: true })
    .eq("id", stickerId);

  if (error) {
    console.error("Failed to mark as example:", error);
    await ctx.editMessageText("❌ Ошибка сохранения");
    return;
  }

  console.log("Marked as example:", stickerId, "style:", sticker.style_preset_id);
  await ctx.editMessageText(`✅ Добавлен как пример для стиля "${sticker.style_preset_id}"`);
});

// Callback: style_example - show first example
bot.action(/^style_example:(.+)$/, async (ctx) => {
  console.log("=== style_example callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const styleId = ctx.match[1];
  console.log("styleId:", styleId);

  // Get style name
  const presets = await getStylePresets();
  const preset = presets.find(p => p.id === styleId);
  const styleName = preset 
    ? (lang === "ru" ? preset.name_ru : preset.name_en)
    : styleId;

  // Get first example
  const example = await getStyleExample(styleId, 0);
  const totalExamples = await countStyleExamples(styleId);
  
  console.log("example found:", !!example, "total:", totalExamples);

  if (!example) {
    // No examples - show message
    const noExamplesText = await getText(lang, "style.no_examples");
    const backText = await getText(lang, "btn.back_to_styles");
    await ctx.editMessageText(noExamplesText, {
      reply_markup: {
        inline_keyboard: [[{ text: backText, callback_data: "back_to_styles" }]]
      }
    });
    return;
  }

  // Show first example sticker
  const titleText = await getText(lang, "style.example_title", { style: styleName });
  const moreText = await getText(lang, "btn.more");
  const backText = await getText(lang, "btn.back_to_styles");

  // Delete old message
  await ctx.deleteMessage().catch(() => {});

  // Send sticker
  const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);

  // Build buttons: [More] if there are more, always [Back]
  const buttons: any[][] = [];
  if (totalExamples > 1) {
    buttons.push([
      { text: moreText, callback_data: `style_example_more:${styleId}:1` },
      { text: backText, callback_data: "back_to_styles" }
    ]);
  } else {
    buttons.push([{ text: backText, callback_data: "back_to_styles" }]);
  }

  const captionMsg = await ctx.reply(titleText, {
    reply_markup: { inline_keyboard: buttons }
  });

  // Auto-delete after 30 seconds
  const chatId = ctx.chat?.id;
  if (chatId) {
    setTimeout(() => {
      ctx.telegram.deleteMessage(chatId, stickerMsg.message_id).catch(() => {});
      ctx.telegram.deleteMessage(chatId, captionMsg.message_id).catch(() => {});
    }, 30000);
  }
});

// Callback: style_example_more - show next example (offset)
bot.action(/^style_example_more:(.+):(\d+)$/, async (ctx) => {
  console.log("=== style_example_more callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const styleId = ctx.match[1];
  const offset = parseInt(ctx.match[2], 10);
  console.log("styleId:", styleId, "offset:", offset);

  // Max 3 examples
  if (offset >= 3) {
    const noMoreText = await getText(lang, "style.no_more_examples");
    const backText = await getText(lang, "btn.back_to_styles");
    await ctx.editMessageText(noMoreText, {
      reply_markup: {
        inline_keyboard: [[{ text: backText, callback_data: "back_to_styles" }]]
      }
    });
    return;
  }

  // Get style name
  const presets = await getStylePresets();
  const preset = presets.find(p => p.id === styleId);
  const styleName = preset 
    ? (lang === "ru" ? preset.name_ru : preset.name_en)
    : styleId;

  // Get next example
  const example = await getStyleExample(styleId, offset);
  const totalExamples = await countStyleExamples(styleId);
  
  console.log("example found:", !!example, "total:", totalExamples, "offset:", offset);

  if (!example) {
    // No more examples
    const noMoreText = await getText(lang, "style.no_more_examples");
    const backText = await getText(lang, "btn.back_to_styles");
    await ctx.editMessageText(noMoreText, {
      reply_markup: {
        inline_keyboard: [[{ text: backText, callback_data: "back_to_styles" }]]
      }
    });
    return;
  }

  // Delete old message
  await ctx.deleteMessage().catch(() => {});

  // Send sticker
  const stickerMsg = await ctx.replyWithSticker(example.telegram_file_id);

  // Build buttons
  const titleText = await getText(lang, "style.example_title", { style: styleName });
  const moreText = await getText(lang, "btn.more");
  const backText = await getText(lang, "btn.back_to_styles");

  const buttons: any[][] = [];
  const nextOffset = offset + 1;
  
  // Show "More" if there are more examples AND we haven't shown 3 yet
  if (totalExamples > nextOffset && nextOffset < 3) {
    buttons.push([
      { text: moreText, callback_data: `style_example_more:${styleId}:${nextOffset}` },
      { text: backText, callback_data: "back_to_styles" }
    ]);
  } else {
    buttons.push([{ text: backText, callback_data: "back_to_styles" }]);
  }

  const captionMsg = await ctx.reply(titleText, {
    reply_markup: { inline_keyboard: buttons }
  });

  // Auto-delete after 30 seconds
  const chatId = ctx.chat?.id;
  if (chatId) {
    setTimeout(() => {
      ctx.telegram.deleteMessage(chatId, stickerMsg.message_id).catch(() => {});
      ctx.telegram.deleteMessage(chatId, captionMsg.message_id).catch(() => {});
    }, 30000);
  }
});

// Callback: back_to_styles - return to style selection
bot.action("back_to_styles", async (ctx) => {
  console.log("=== back_to_styles callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  // Delete current message
  await ctx.deleteMessage().catch(() => {});

  await sendStyleKeyboardFlat(ctx, lang);
});

// Callback: onboarding emotion selection
bot.action(/^onboarding_emotion:(.+):(.+)$/, async (ctx) => {
  console.log("=== onboarding_emotion callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const stickerId = ctx.match[1];
  const emotionId = ctx.match[2];
  console.log("stickerId:", stickerId, "emotionId:", emotionId);

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  // Check if user is in onboarding step 1
  if (user.onboarding_step !== 1) {
    console.log("User not in onboarding step 1, skipping");
    return;
  }

  // Get sticker to find source photo
  const { data: sticker } = await supabase
    .from("stickers")
    .select("source_photo_file_id, user_id")
    .eq("id", stickerId)
    .maybeSingle();

  if (!sticker?.source_photo_file_id || sticker.user_id !== user.id) {
    console.log("Sticker not found or doesn't belong to user");
    return;
  }

  // Get or create session
  let session = await getActiveSession(user.id);
  if (!session?.id) {
    const { data: newSession } = await supabase
      .from("sessions")
      .insert({ user_id: user.id, state: "wait_emotion", is_active: true, env: config.appEnv })
      .select()
      .single();
    session = newSession;
  }
  if (!session?.id) return;

  // Update session with photo and emotion
  await supabase
    .from("sessions")
    .update({
      state: "wait_emotion",
      is_active: true,
      current_photo_file_id: sticker.source_photo_file_id,
      selected_emotion: emotionId,
    })
    .eq("id", session.id);

  // Get emotion preset
  const { data: emotionPreset } = await supabase
    .from("emotion_presets")
    .select("prompt_hint")
    .eq("id", emotionId)
    .maybeSingle();

  const emotionHint = emotionPreset?.prompt_hint || emotionId;

  // Start generation
  await startGeneration(ctx, user, session, lang, {
    generationType: "emotion",
    promptFinal: `Add ${emotionHint} expression to this sticker character`,
    emotionPrompt: emotionHint,
    selectedEmotion: emotionId,
  });

  // Delete onboarding message
  await ctx.deleteMessage().catch(() => {});
});

// Callback: skip onboarding
bot.action("onboarding_skip", async (ctx) => {
  console.log("=== onboarding_skip callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  // Skip onboarding
  await supabase.rpc("skip_onboarding", { p_user_id: user.id });

  const skipText = lang === "ru"
    ? "Хорошо! Когда захочешь добавить эмоцию — нажми кнопку под стикером 😊"
    : "Okay! When you want to add an emotion — click the button under the sticker 😊";

  await ctx.editMessageText(skipText);
});

// Callback: new_photo (after onboarding)
bot.action("new_photo", async (ctx) => {
  console.log("=== new_photo callback ===");
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";

  // Create new session
  await supabase
    .from("sessions")
    .update({ is_active: false })
    .eq("user_id", user.id);

  await supabase
    .from("sessions")
    .insert({ user_id: user.id, state: "wait_photo", is_active: true, env: config.appEnv });

  const text = lang === "ru"
    ? "📷 Отправь фото — сделаем новый стикер!"
    : "📷 Send a photo — let's create a new sticker!";

  await ctx.editMessageText(text);
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
  const startTime = Date.now();
  console.log("=== PAYMENT: pack_select START ===");
  console.log("timestamp:", new Date().toISOString());
  
  safeAnswerCbQuery(ctx);
  const telegramId = ctx.from?.id;
  console.log("telegramId:", telegramId);
  if (!telegramId) {
    console.log("PAYMENT ERROR: no telegramId");
    return;
  }

  const user = await getUser(telegramId);
  console.log("getUser took:", Date.now() - startTime, "ms");
  if (!user?.id) {
    console.log("PAYMENT ERROR: user not found");
    return;
  }
  console.log("user_id:", user.id, "username:", user.username);

  const lang = user.lang || "en";
  const match = ctx.match;
  const credits = parseInt(match[1], 10);
  const price = parseInt(match[2], 10);
  console.log("pack selected: credits=", credits, "price=", price);

  // Validate pack
  const pack = CREDIT_PACKS.find((p) => p.credits === credits && p.price === price);
  if (!pack) {
    console.log("PAYMENT ERROR: invalid pack");
    await ctx.reply(await getText(lang, "payment.invalid_pack"));
    return;
  }
  console.log("pack validated:", pack.label_en);

  // Cancel old active transactions
  const cancelStart = Date.now();
  await supabase
    .from("transactions")
    .update({ state: "canceled", is_active: false })
    .eq("user_id", user.id)
    .eq("is_active", true);
  console.log("cancel old transactions took:", Date.now() - cancelStart, "ms");

  // Create new transaction
  const createStart = Date.now();
  const { data: transaction, error: createError } = await supabase
    .from("transactions")
    .insert({
      user_id: user.id,
      amount: credits,
      price: price,
      state: "created",
      is_active: true,
      env: config.appEnv,
    })
    .select("*")
    .single();
  console.log("create transaction took:", Date.now() - createStart, "ms");

  if (!transaction) {
    console.log("PAYMENT ERROR: transaction not created, error:", createError);
    await ctx.reply(await getText(lang, "payment.error_create"));
    return;
  }
  console.log("transaction created:", transaction.id);

  // Send invoice via Telegram Stars
  try {
    const invoicePayload = `[${transaction.id}]`;
    const title = await getText(lang, "payment.invoice_title", { credits });
    const description = await getText(lang, "payment.invoice_description", { credits });
    const label = await getText(lang, "payment.invoice_label");

    console.log("sending invoice: payload=", invoicePayload, "price=", price);
    const invoiceStart = Date.now();
    const response = await axios.post(
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
    console.log("sendInvoice took:", Date.now() - invoiceStart, "ms");
    console.log("sendInvoice response ok:", response.data?.ok);
    console.log("=== PAYMENT: pack_select COMPLETE ===");
    console.log("total time:", Date.now() - startTime, "ms");
  } catch (err: any) {
    console.error("=== PAYMENT ERROR: sendInvoice failed ===");
    console.error("error:", err.response?.data || err.message);
    console.error("total time:", Date.now() - startTime, "ms");
    await ctx.reply(await getText(lang, "payment.error_invoice"));
  }
});

// Pre-checkout query handler
// OPTIMIZED: No DB queries - instant response to avoid Telegram timeout (10s limit)
// All validation happens in successful_payment
bot.on("pre_checkout_query", async (ctx) => {
  const startTime = Date.now();
  console.log("=== PAYMENT: pre_checkout_query START ===");
  console.log("timestamp:", new Date().toISOString());
  
  const query = ctx.preCheckoutQuery;
  console.log("query_id:", query.id);
  console.log("from:", ctx.from?.id, ctx.from?.username);
  console.log("payload:", query.invoice_payload);
  console.log("amount:", query.total_amount);
  console.log("currency:", query.currency);

  // Instant OK response - no DB queries to avoid timeout
  await ctx.answerPreCheckoutQuery(true);
  
  console.log("=== PAYMENT: pre_checkout_query OK ===");
  console.log("total time:", Date.now() - startTime, "ms");
});

// Successful payment handler
bot.on("successful_payment", async (ctx) => {
  const startTime = Date.now();
  console.log("=== PAYMENT: successful_payment START ===");
  console.log("timestamp:", new Date().toISOString());
  
  const payment = ctx.message.successful_payment;
  const invoicePayload = payment.invoice_payload;

  console.log("from:", ctx.from?.id, ctx.from?.username);
  console.log("charge_id:", payment.telegram_payment_charge_id);
  console.log("provider_charge_id:", payment.provider_payment_charge_id);
  console.log("amount:", payment.total_amount);
  console.log("currency:", payment.currency);
  console.log("payload:", invoicePayload);

  // Extract transaction ID
  const transactionId = invoicePayload.replace(/[\[\]]/g, "");
  console.log("transactionId:", transactionId);

  // Idempotency guard: if this charge was already processed, skip
  const checkStart = Date.now();
  const { data: existingCharge } = await supabase
    .from("transactions")
    .select("id, state")
    .eq("telegram_payment_charge_id", payment.telegram_payment_charge_id)
    .maybeSingle();
  console.log("idempotency check took:", Date.now() - checkStart, "ms");
  console.log("existingCharge:", existingCharge?.id, existingCharge?.state);

  if (existingCharge?.state === "done") {
    console.log(">>> SKIP: Payment already processed by charge id:", payment.telegram_payment_charge_id);
    console.log("=== PAYMENT: successful_payment SKIPPED (duplicate) ===");
    return;
  }

  // Atomic update: only one request can successfully change state from "created" to "done"
  // Note: We skip "processed" state now - pre_checkout_query no longer updates DB
  const updateStart = Date.now();
  const { data: updatedTransactions, error: updateError } = await supabase
    .from("transactions")
    .update({
      state: "done",
      is_active: false,
      telegram_payment_charge_id: payment.telegram_payment_charge_id,
      provider_payment_charge_id: payment.provider_payment_charge_id,
    })
    .eq("id", transactionId)
    .eq("state", "created")  // Changed from "processed" - now direct created -> done
    .is("telegram_payment_charge_id", null)
    .select("*");
  console.log("update transaction took:", Date.now() - updateStart, "ms");

  if (updateError) {
    console.log("PAYMENT ERROR: update to done failed:", updateError);
  }

  const transaction = updatedTransactions?.[0];
  console.log("update result - transaction found:", !!transaction, "id:", transaction?.id);

  if (!transaction) {
    // Already processed or not found - this prevents double crediting
    console.log(">>> SKIP: Transaction already processed or not found:", transactionId);
    console.log("=== PAYMENT: successful_payment SKIPPED (no transaction) ===");
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

  // First purchase bonus: +2 credits
  const isFirstPurchase = user && !user.has_purchased;
  const bonusCredits = isFirstPurchase ? 2 : 0;
  
  if (isFirstPurchase) {
    console.log("First purchase detected! Adding bonus:", bonusCredits);
    
    // Add bonus credits via transaction
    await supabase.from("transactions").insert({
      user_id: user.id,
      amount: bonusCredits,
      price: 0,
      state: "done",
      is_active: false,
      env: config.appEnv,
    });
    
    // Set has_purchased = true
    await supabase
      .from("users")
      .update({ has_purchased: true })
      .eq("id", user.id);
  }

  // Re-fetch user to get updated balance (after trigger executed + bonus)
  const { data: updatedUser } = await supabase
    .from("users")
    .select("*")
    .eq("id", transaction.user_id)
    .maybeSingle();

  const finalUser = updatedUser || user;
  console.log("user after trigger:", finalUser?.id, "credits:", finalUser?.credits, "added:", transaction.amount, "bonus:", bonusCredits);

  if (finalUser) {
    const lang = finalUser.lang || "en";
    const currentCredits = finalUser.credits || 0;

    // Show payment success message
    await ctx.reply(await getText(lang, "payment.success", {
      amount: transaction.amount,
      balance: currentCredits,
    }));

    // Show bonus message if first purchase
    if (isFirstPurchase) {
      await ctx.reply(await getText(lang, "paywall.bonus_applied"));
    }

    // Send payment notification (async, non-blocking)
    sendNotification({
      type: "new_payment",
      message: `👤 @${finalUser.username || finalUser.telegram_id}\n📦 Пакет: ${transaction.amount} кредитов\n⭐ Сумма: ${transaction.price} Stars${isFirstPurchase ? "\n🎁 Первая покупка! +2 бонус" : ""}`,
    }).catch(console.error);

    // Check if there's a pending session waiting for credits (paywall or normal)
    const session = await getActiveSession(finalUser.id);
    const isWaitingForCredits = session?.state === "wait_buy_credit" || session?.state === "wait_first_purchase";
    
    // === AI Assistant: paid after paywall — trigger generation with assistant params ===
    if (isWaitingForCredits && !session.prompt_final) {
      // Check if there's a completed/active assistant session with params
      const { data: aSessionForPayment } = await supabase
        .from("assistant_sessions")
        .select("*")
        .eq("session_id", session.id)
        .in("status", ["active", "completed"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (aSessionForPayment?.style) {
        const params = getAssistantParams(aSessionForPayment);
        const promptFinal = buildAssistantPrompt(params);

        // Save prompt and start generation
        await supabase
          .from("sessions")
          .update({ prompt_final: promptFinal, user_input: `[assistant] ${params.style}, ${params.emotion}, ${params.pose}` })
          .eq("id", session.id);

        // Keep assistant session active so user can continue dialog after generation
        // (closed on new dialog, manual switch, or timeout)

        // Now fall through to the normal auto-continue logic below
        session.prompt_final = promptFinal;
      }
    }

    if (isWaitingForCredits && session.prompt_final) {
      const creditsNeeded = session.credits_spent || 1;

      if (currentCredits >= creditsNeeded) {
        const nextState =
          session.pending_generation_type === "emotion" ? "processing_emotion" : "processing";

        // Auto-continue generation: deduct credits atomically
        const { data: deducted } = await supabase
          .rpc("deduct_credits", { p_user_id: finalUser.id, p_amount: creditsNeeded });

        if (deducted) {
          await supabase
            .from("sessions")
            .update({ state: nextState, is_active: true })
            .eq("id", session.id);

          await enqueueJob(session.id, finalUser.id);

          // Alert: generation after payment
          const isAssistantPayment = session.user_input?.startsWith("[assistant]");
          sendAlert({
            type: "generation_started",
            message: "Generation after payment",
            details: {
              mode: isAssistantPayment ? "🤖 assistant" : "✋ manual",
              user: `@${finalUser.username || finalUser.telegram_id}`,
              style: session.selected_style_id || "-",
              emotion: session.selected_emotion || session.emotion_prompt || "-",
              prompt: (session.prompt_final || "").slice(0, 200),
            },
          }).catch(console.error);

          await sendProgressStart(ctx, session.id, lang);
        } else {
          console.error("Auto-continue failed: not enough credits after payment");
        }
      } else {
        await ctx.reply(await getText(lang, "payment.need_more", {
          needed: creditsNeeded - currentCredits,
        }));
      }
    }
    console.log("=== PAYMENT: successful_payment COMPLETE ===");
    console.log("total time:", Date.now() - startTime, "ms");
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

// ============================================
// ABANDONED CART PROCESSING
// ============================================

const ABANDONED_CART_DELAY_MS = 15 * 60 * 1000; // 15 minutes
const ABANDONED_CART_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Map original price to discounted price (10% off)
const DISCOUNT_MAP: Record<number, number> = {
  150: 135, // Лайт: 150 -> 135
  300: 270, // Бро: 300 -> 270
};

async function processAbandonedCarts() {
  try {
    const cutoffTime = new Date(Date.now() - ABANDONED_CART_DELAY_MS).toISOString();
    
    // Find transactions older than 30 minutes without reminder
    const { data: abandoned, error } = await supabase
      .from("transactions")
      .select("*, users(*)")
      .eq("state", "created")
      .eq("reminder_sent", false)
      .gt("price", 0)
      .lt("created_at", cutoffTime)
      .limit(10); // Process in batches

    if (error) {
      console.error("processAbandonedCarts query error:", error);
      return;
    }

    if (!abandoned?.length) {
      return;
    }

    console.log(`Processing ${abandoned.length} abandoned carts`);

    for (const tx of abandoned) {
      const user = tx.users;
      if (!user?.telegram_id) continue;

      const lang = user.lang || "en";
      const discountedPrice = DISCOUNT_MAP[tx.price];
      
      // Skip if no discount available for this price
      if (!discountedPrice) {
        console.log(`No discount for price ${tx.price}, skipping`);
        // Mark as sent to avoid re-processing
        await supabase
          .from("transactions")
          .update({ reminder_sent: true, reminder_sent_at: new Date().toISOString() })
          .eq("id", tx.id);
        continue;
      }

      // Determine pack name
      const packName = tx.amount === 10 
        ? (lang === "ru" ? "Лайт" : "Light")
        : tx.amount === 30 
          ? (lang === "ru" ? "Бро" : "Bro")
          : `${tx.amount}`;

      // Build message
      const message = lang === "ru"
        ? `🛒 Ты выбрал пакет "${packName}", но не завершил оплату.\n\nСпециально для тебя — скидка 10%:\n${tx.amount} стикеров за ${discountedPrice}⭐ вместо ${tx.price}⭐\n\nПредложение действует 24 часа ⏰`
        : `🛒 You selected the "${packName}" pack but didn't complete the payment.\n\nSpecial offer for you — 10% off:\n${tx.amount} stickers for ${discountedPrice}⭐ instead of ${tx.price}⭐\n\nOffer valid for 24 hours ⏰`;

      const buttonText = lang === "ru"
        ? `Оплатить со скидкой ${discountedPrice}⭐`
        : `Pay with discount ${discountedPrice}⭐`;

      try {
        await bot.telegram.sendMessage(
          user.telegram_id,
          message,
          Markup.inlineKeyboard([
            [Markup.button.callback(buttonText, `pack_${tx.amount}_${discountedPrice}`)]
          ])
        );

        console.log(`Sent abandoned cart reminder to ${user.username || user.telegram_id}`);

        // Mark reminder as sent
        await supabase
          .from("transactions")
          .update({ reminder_sent: true, reminder_sent_at: new Date().toISOString() })
          .eq("id", tx.id);

      } catch (err: any) {
        console.error(`Failed to send reminder to ${user.telegram_id}:`, err.message);
        // Still mark as sent to avoid retry spam
        await supabase
          .from("transactions")
          .update({ reminder_sent: true, reminder_sent_at: new Date().toISOString() })
          .eq("id", tx.id);
      }
    }
  } catch (err) {
    console.error("processAbandonedCarts error:", err);
  }
}

const ABANDONED_CART_ALERT_DELAY_MS = 15 * 60 * 1000; // 15 minutes

async function processAbandonedCartAlerts() {
  try {
    const cutoffTime = new Date(Date.now() - ABANDONED_CART_ALERT_DELAY_MS).toISOString();
    
    // Find transactions older than 15 minutes without alert
    const { data: abandoned, error } = await supabase
      .from("transactions")
      .select("*, users(*)")
      .eq("state", "created")
      .eq("alert_sent", false)
      .gt("price", 0)
      .lt("created_at", cutoffTime)
      .limit(10); // Process in batches

    if (error) {
      console.error("processAbandonedCartAlerts query error:", error);
      return;
    }

    if (!abandoned?.length) {
      return;
    }

    console.log(`Processing ${abandoned.length} abandoned cart alerts`);

    for (const tx of abandoned) {
      const user = tx.users;
      if (!user?.telegram_id) continue;

      const minutesSince = Math.round((Date.now() - new Date(tx.created_at).getTime()) / 60000);
      
      // Determine pack name
      const packName = tx.amount === 10 ? "Лайт" : tx.amount === 30 ? "Бро" : `${tx.amount} кредитов`;

      const message = `👤 @${user.username || 'no_username'} (${user.telegram_id})
📦 Пакет: ${packName} (${tx.amount} кредитов)
💰 Сумма: ${tx.price}⭐
⏱ Прошло: ${minutesSince} мин`;

      try {
        await sendNotification({
          type: "abandoned_cart",
          message,
          buttons: [[{
            text: "Написать пользователю",
            url: `https://t.me/${config.supportBotUsername}?start=reply_${user.telegram_id}`
          }]]
        });

        console.log(`Sent abandoned cart alert for ${user.username || user.telegram_id}`);

        // Mark alert as sent
        await supabase
          .from("transactions")
          .update({ alert_sent: true, alert_sent_at: new Date().toISOString() })
          .eq("id", tx.id);

      } catch (err: any) {
        console.error(`Failed to send alert for ${user.telegram_id}:`, err.message);
        // Still mark as sent to avoid retry spam
        await supabase
          .from("transactions")
          .update({ alert_sent: true, alert_sent_at: new Date().toISOString() })
          .eq("id", tx.id);
      }
    }
  } catch (err) {
    console.error("processAbandonedCartAlerts error:", err);
  }
}

// Start abandoned cart processing interval
// ============================================
// EXPIRED ASSISTANT SESSIONS
// ============================================

const ASSISTANT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function processExpiredAssistantSessions() {
  try {
    // Expire old assistant_sessions rows
    const expiredCount = await expireOldAssistantSessions(ASSISTANT_SESSION_TTL_MS);
    if (expiredCount > 0) {
      console.log(`Expired ${expiredCount} assistant sessions (30 min timeout)`);
    }

    // Also expire the corresponding sessions rows
    const cutoff = new Date(Date.now() - ASSISTANT_SESSION_TTL_MS).toISOString();
    await supabase
      .from("sessions")
      .update({ state: "expired", is_active: false })
      .in("state", ["assistant_wait_photo", "assistant_chat"])
      .eq("is_active", true)
      .lt("updated_at", cutoff);
  } catch (err) {
    console.error("processExpiredAssistantSessions error:", err);
  }
}

function startAbandonedCartProcessor() {
  console.log("Starting abandoned cart processor (every 5 minutes)");
  
  // Run immediately on start
  processAbandonedCartAlerts();  // 15 min alert to team
  processAbandonedCarts();       // 30 min discount to user
  processExpiredAssistantSessions(); // 30 min timeout for assistant sessions
  
  // Then run every 5 minutes
  setInterval(() => {
    processAbandonedCartAlerts();
    processAbandonedCarts();
    processExpiredAssistantSessions();
  }, ABANDONED_CART_CHECK_INTERVAL_MS);
}

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
    console.log("Deleting webhook...");
    await bot.telegram.deleteWebhook();
    console.log("Webhook deleted. Launching long polling...");
    await bot.launch();
    console.log("Bot launched with long polling");
  }
}

startBot().then(() => {
  // Start background processors after bot is ready
  startAbandonedCartProcessor();
}).catch(async (err) => {
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

